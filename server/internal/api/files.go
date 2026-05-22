package api

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// FilesHandler serves the REST endpoints for uploading and
// downloading attachments. Construct via NewFilesHandler.
type FilesHandler struct {
	auth        *auth.Service
	attachments *attachments.Service
	convs       *conversations.Service
	messages    *messages.Service
	maxBytes    int64
}

// NewFilesHandler wires the services. maxBytes is the per-upload cap
// in bytes (e.g. 25 MiB == 25<<20).
func NewFilesHandler(
	authSvc *auth.Service,
	attSvc *attachments.Service,
	convsSvc *conversations.Service,
	msgsSvc *messages.Service,
	maxBytes int64,
) *FilesHandler {
	if maxBytes <= 0 {
		maxBytes = 25 << 20
	}
	return &FilesHandler{
		auth:        authSvc,
		attachments: attSvc,
		convs:       convsSvc,
		messages:    msgsSvc,
		maxBytes:    maxBytes,
	}
}

// Mount registers POST /api/uploads (Bearer auth) and GET
// /api/files/{id} (Bearer header *or* ?token= query — `<img src>`
// can't set headers).
func (h *FilesHandler) Mount(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(requireAuth(h.auth))
		r.Post("/api/uploads", h.upload)
	})
	r.Group(func(r chi.Router) {
		r.Use(requireAuthHeaderOrQuery(h.auth))
		r.Get("/api/files/{id}", h.download)
		r.Get("/api/messages/{id}/attachments.zip", h.downloadMessageZip)
	})
}

// upload streams a single multipart form file named "file" into the
// attachments store. Returns the new AttachmentView.
func (h *FilesHandler) upload(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	// Cap the whole body, with a little slack for multipart headers,
	// so a malicious sender can't stream unbounded bytes.
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes+1<<14)

	mr, err := r.MultipartReader()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "expected multipart/form-data body")
		return
	}

	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid multipart body: "+err.Error())
			return
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		defer part.Close()

		filename := safeFilename(part.FileName())
		if filename == "" {
			writeJSONError(w, http.StatusBadRequest, "file part missing a filename")
			return
		}
		mimeType := part.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}

		a, err := h.attachments.Store(r.Context(), me.ID, filename, mimeType, part, h.maxBytes)
		if errors.Is(err, attachments.ErrTooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("file exceeds the %d-byte upload limit", h.maxBytes))
			return
		}
		if err != nil {
			slog.Error("attachment store failed", "error", err, "user_id", me.ID)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, attachmentToView(a))
		return
	}

	writeJSONError(w, http.StatusBadRequest, `multipart body has no "file" part`)
}

// download streams the file bytes. Auth permission: the caller must be
// the uploader (covers orphan uploads) OR a member of the conversation
// the attachment is linked to. Anything else is 404 to avoid
// enumeration.
func (h *FilesHandler) download(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid id")
		return
	}

	a, err := h.attachments.Get(r.Context(), id)
	if errors.Is(err, attachments.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		slog.Error("attachment get failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	ok, err := h.canRead(r.Context(), a, me.ID)
	if err != nil {
		slog.Error("attachment permission check failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !ok {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}

	f, _, err := h.attachments.Open(r.Context(), id)
	if err != nil {
		slog.Error("attachment open failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", a.MimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(a.SizeBytes, 10))
	// "inline" so browsers render images natively; downloads still
	// pick up the original filename via the filename* parameter.
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename=%q`, a.Filename))
	http.ServeContent(w, r, a.Filename, a.CreatedAt, f)
}

// downloadMessageZip streams every attachment on a single message
// packed into a ZIP archive, so the user can grab the whole batch in
// one click instead of N right-click-save-as.
//
// Permission: the caller must be a member of the message's
// conversation. Same gate as the per-file download. The ZIP is
// streamed straight to the response — no buffering in RAM — so this
// works fine for the family-scale max-25MiB-per-file world.
//
// Filename collisions inside the ZIP get a "(n)" suffix so two
// attachments named "image.png" become "image.png" and "image (2).png".
func (h *FilesHandler) downloadMessageZip(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	msgID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || msgID <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid id")
		return
	}

	msg, err := h.messages.Get(r.Context(), msgID)
	if errors.Is(err, messages.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		slog.Error("zip: message lookup failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	ok, err := h.convs.IsMember(r.Context(), msg.ConversationID, me.ID)
	if err != nil {
		slog.Error("zip: membership check failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !ok {
		// 404 not 403 — don't leak whether the message exists.
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}

	attsByMsg, err := h.attachments.ListForMessages(r.Context(), []int64{msg.ID})
	if err != nil {
		slog.Error("zip: list attachments failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	atts := attsByMsg[msg.ID]
	if len(atts) == 0 {
		writeJSONError(w, http.StatusNotFound, "no attachments on this message")
		return
	}

	// Browser-friendly filename for the bundle: oreohouse-msg-<id>-attachments.zip.
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="oreohouse-msg-%d-attachments.zip"`, msg.ID))

	zw := zip.NewWriter(w)
	defer zw.Close()

	used := make(map[string]int) // dedupe filename collisions inside the zip
	for _, a := range atts {
		name := uniqueZipName(a.Filename, used)
		f, _, openErr := h.attachments.Open(r.Context(), a.ID)
		if openErr != nil {
			slog.Warn("zip: open attachment failed", "error", openErr, "attachment_id", a.ID)
			continue
		}
		header := &zip.FileHeader{
			Name:     name,
			Method:   zip.Deflate,
			Modified: a.CreatedAt,
		}
		entry, werr := zw.CreateHeader(header)
		if werr != nil {
			_ = f.Close()
			slog.Warn("zip: create entry failed", "error", werr, "attachment_id", a.ID)
			continue
		}
		if _, copyErr := io.Copy(entry, f); copyErr != nil {
			slog.Warn("zip: stream entry failed", "error", copyErr, "attachment_id", a.ID)
		}
		_ = f.Close()
	}
}

// uniqueZipName returns name unchanged on first use, then "name (2)",
// "name (3)", … on subsequent uses. The "(n)" goes BEFORE the
// extension so it sorts naturally: image.png, image (2).png, etc.
func uniqueZipName(name string, used map[string]int) string {
	if _, ok := used[name]; !ok {
		used[name] = 1
		return name
	}
	used[name]++
	n := used[name]
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return fmt.Sprintf("%s (%d)", name, n)
	}
	return fmt.Sprintf("%s (%d)%s", name[:dot], n, name[dot:])
}

func (h *FilesHandler) canRead(ctx context.Context, a attachments.Attachment, userID int64) (bool, error) {
	if a.UploaderID == userID {
		return true, nil
	}
	if a.MessageID == 0 {
		// Orphan upload — only the uploader can fetch it.
		return false, nil
	}
	m, err := h.messages.Get(ctx, a.MessageID)
	if err != nil {
		if errors.Is(err, messages.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return h.convs.IsMember(ctx, m.ConversationID, userID)
}

func attachmentToView(a attachments.Attachment) proto.AttachmentView {
	return proto.AttachmentView{
		ID:          a.ID,
		Filename:    a.Filename,
		MimeType:    a.MimeType,
		SizeBytes:   a.SizeBytes,
		ImageWidth:  a.ImageWidth,
		ImageHeight: a.ImageHeight,
	}
}

// requireAuthHeaderOrQuery is a copy of requireAuth that also accepts
// the token as a ?token= query parameter. Used only for file
// downloads so the Tauri webview can put the URL straight into
// <img src=...> without setting a header.
func requireAuthHeaderOrQuery(svc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerToken(r)
			if token == "" {
				token = r.URL.Query().Get("token")
			}
			if token == "" {
				writeJSONError(w, http.StatusUnauthorized, "missing token")
				return
			}
			u, _, err := svc.LookupSession(r.Context(), token)
			if errors.Is(err, auth.ErrSessionNotFound) || errors.Is(err, auth.ErrSessionExpired) {
				writeJSONError(w, http.StatusUnauthorized, "invalid session")
				return
			}
			if err != nil {
				slog.Error("file auth middleware: lookup session failed", "error", err)
				writeJSONError(w, http.StatusInternalServerError, "internal error")
				return
			}
			ctx := context.WithValue(r.Context(), ctxUserKey, u)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// safeFilename strips any path components a malicious sender might
// have stuffed into the multipart FileName field. We only ever store
// under a random storage_path on disk, but a clean display filename
// is nicer for downloads.
func safeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = filepath.Base(name)
	if name == "." || name == "/" || name == `\` {
		return ""
	}
	return name
}

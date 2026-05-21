package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// maxAvatarBytes caps a single avatar upload. Avatars don't need to be
// huge — clamp tight so the upload is fast even on the slowest LAN.
const maxAvatarBytes = 2 << 20 // 2 MiB

// allowedAvatarMimes whitelists what we accept for the avatar slot.
// Anything else gets a 415.
var allowedAvatarMimes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

// ProfileBroadcaster is the slice of the WS hub the profile handler
// uses to fan profile updates out to every connected client. *ws.Hub
// satisfies it; tests can pass a fake.
type ProfileBroadcaster interface {
	Broadcast(msg []byte)
}

// noopProfileBroadcaster is the fallback when the handler is
// constructed without a hub.
type noopProfileBroadcaster struct{}

func (noopProfileBroadcaster) Broadcast(_ []byte) {}

// ProfileHandler serves /api/me/* (the caller's own profile) and
// GET /api/users/{id}/avatar for streaming any user's avatar bytes.
type ProfileHandler struct {
	auth        *auth.Service
	attachments *attachments.Service
	hub         ProfileBroadcaster
}

// NewProfileHandler wires the auth + attachments services and a hub
// broadcaster for live profile-change fanout.
func NewProfileHandler(
	authSvc *auth.Service,
	attSvc *attachments.Service,
	hub ProfileBroadcaster,
) *ProfileHandler {
	if hub == nil {
		hub = noopProfileBroadcaster{}
	}
	return &ProfileHandler{auth: authSvc, attachments: attSvc, hub: hub}
}

func (h *ProfileHandler) Mount(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(requireAuth(h.auth))
		r.Put("/api/me/profile", h.setProfile)
		r.Post("/api/me/avatar", h.uploadAvatar)
		r.Delete("/api/me/avatar", h.deleteAvatar)
	})
	r.Group(func(r chi.Router) {
		// Avatar fetch accepts ?token= so <img src> can render directly.
		r.Use(requireAuthHeaderOrQuery(h.auth))
		r.Get("/api/users/{id}/avatar", h.getAvatar)
	})
}

// setProfile handles PUT /api/me/profile.
//
//	{ "display_name": "..." }   (empty string clears it)
//	→ 200 with the updated UserInfo
//	→ 400 on validation failure
func (h *ProfileHandler) setProfile(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	var req proto.SetProfileRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := h.auth.SetDisplayName(r.Context(), me.ID, req.DisplayName); err != nil {
		switch {
		case errors.Is(err, auth.ErrDisplayNameTooLong):
			writeJSONError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, auth.ErrUserNotFound):
			writeJSONError(w, http.StatusNotFound, "user not found")
		default:
			slog.Error("profile: set display_name failed", "error", err, "user_id", me.ID)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	updated, err := h.auth.GetUserByID(r.Context(), me.ID)
	if err != nil {
		slog.Error("profile: reload user failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	view := userToProtoInfo(updated)
	h.broadcastProfileChange(view)
	writeJSON(w, http.StatusOK, view)
}

// uploadAvatar handles POST /api/me/avatar — multipart form with a
// "file" part. Stores via the attachments service, then links via
// SetAvatarAttachmentID. Returns the updated UserInfo.
func (h *ProfileHandler) uploadAvatar(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes+1<<14)
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
		filename := safeFilename(part.FileName())
		if filename == "" {
			filename = "avatar"
		}
		mimeType := part.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		if !allowedAvatarMimes[mimeType] {
			_ = part.Close()
			writeJSONError(w, http.StatusUnsupportedMediaType,
				"avatar must be a PNG, JPEG, GIF, or WEBP image")
			return
		}
		a, err := h.attachments.Store(r.Context(), me.ID, filename, mimeType, part, maxAvatarBytes)
		_ = part.Close()
		if errors.Is(err, attachments.ErrTooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("avatar exceeds the %d-byte upload limit", maxAvatarBytes))
			return
		}
		if err != nil {
			slog.Error("profile: avatar store failed", "error", err, "user_id", me.ID)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := h.auth.SetAvatarAttachmentID(r.Context(), me.ID, a.ID); err != nil {
			slog.Error("profile: link avatar failed", "error", err)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		updated, err := h.auth.GetUserByID(r.Context(), me.ID)
		if err != nil {
			slog.Error("profile: reload user failed", "error", err)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		view := userToProtoInfo(updated)
		h.broadcastProfileChange(view)
		writeJSON(w, http.StatusOK, view)
		return
	}
	writeJSONError(w, http.StatusBadRequest, `multipart body has no "file" part`)
}

// deleteAvatar handles DELETE /api/me/avatar.
func (h *ProfileHandler) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	if err := h.auth.SetAvatarAttachmentID(r.Context(), me.ID, 0); err != nil {
		slog.Error("profile: clear avatar failed", "error", err, "user_id", me.ID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	updated, err := h.auth.GetUserByID(r.Context(), me.ID)
	if err != nil {
		slog.Error("profile: reload user failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	view := userToProtoInfo(updated)
	h.broadcastProfileChange(view)
	writeJSON(w, http.StatusOK, view)
}

// getAvatar handles GET /api/users/{id}/avatar — streams the target
// user's avatar bytes. Any authenticated user can read any avatar
// (intentional: avatars are public-within-the-LAN identifying data).
// Returns 404 when the user has no avatar set.
func (h *ProfileHandler) getAvatar(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	target, err := h.auth.GetUserByID(r.Context(), id)
	if errors.Is(err, auth.ErrUserNotFound) {
		writeJSONError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		slog.Error("profile: get user failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if target.AvatarAttachmentID == 0 {
		writeJSONError(w, http.StatusNotFound, "no avatar")
		return
	}
	a, err := h.attachments.Get(r.Context(), target.AvatarAttachmentID)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "avatar missing")
		return
	}
	f, _, err := h.attachments.Open(r.Context(), a.ID)
	if err != nil {
		slog.Error("profile: open avatar failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", a.MimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(a.SizeBytes, 10))
	// Cache for an hour; if the user uploads a new avatar the
	// attachment id changes so the URL changes too.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, a.Filename, a.CreatedAt, f)
}

// broadcastProfileChange marshals + emits a user_profile_changed
// message to every connected client. Best-effort — log on marshal
// failure but don't surface.
func (h *ProfileHandler) broadcastProfileChange(view proto.UserInfo) {
	msg := proto.UserProfileChangedMessage{
		Type: proto.TypeUserProfileChanged,
		User: view,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		slog.Error("profile: marshal user_profile_changed failed", "error", err)
		return
	}
	h.hub.Broadcast(b)
}

func userToProtoInfo(u auth.User) proto.UserInfo {
	return proto.UserInfo{
		ID:            u.ID,
		Username:      u.Username,
		CreatedAt:     u.CreatedAt.UTC().Format(time.RFC3339Nano),
		DisplayName:   u.DisplayName,
		HasAvatar:     u.AvatarAttachmentID > 0,
		AvatarVersion: u.AvatarAttachmentID,
	}
}

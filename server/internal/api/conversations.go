package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// maxBodyBytes caps the size of any conversations-API JSON body. The
// requests we accept are tiny.
const maxConvBodyBytes = 4 << 10

// ConversationsHandler serves /api/conversations/* endpoints. Construct
// via NewConversationsHandler.
type ConversationsHandler struct {
	auth     *auth.Service
	convs    *conversations.Service
	messages *messages.Service
}

// NewConversationsHandler wires the three services together. auth is
// used by the requireAuth middleware.
func NewConversationsHandler(
	authSvc *auth.Service,
	convsSvc *conversations.Service,
	msgsSvc *messages.Service,
) *ConversationsHandler {
	return &ConversationsHandler{auth: authSvc, convs: convsSvc, messages: msgsSvc}
}

// Mount registers the /api/conversations/* routes, all behind
// Bearer-token auth.
func (h *ConversationsHandler) Mount(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(requireAuth(h.auth))
		r.Get("/api/conversations", h.list)
		r.Post("/api/conversations/dm", h.createDM)
		r.Get("/api/conversations/{id}/messages", h.listMessages)
	})
}

// list handles GET /api/conversations.
func (h *ConversationsHandler) list(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convs, err := h.convs.ListForUser(r.Context(), me.ID)
	if err != nil {
		slog.Error("list conversations failed", "error", err, "user_id", me.ID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	views, err := h.toViews(r, convs)
	if err != nil {
		slog.Error("hydrating members failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, proto.ListConversationsResponse{Conversations: views})
}

// createDM handles POST /api/conversations/dm.
func (h *ConversationsHandler) createDM(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	var req proto.CreateDMRequest
	if err := decodeConvJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.UserID == 0 {
		writeJSONError(w, http.StatusBadRequest, "user_id is required")
		return
	}

	c, err := h.convs.FindOrCreateDM(r.Context(), me.ID, req.UserID)
	if errors.Is(err, conversations.ErrSelfDM) {
		writeJSONError(w, http.StatusBadRequest, "cannot DM yourself")
		return
	}
	if err != nil {
		slog.Error("create dm failed", "error", err, "user_id", me.ID, "other", req.UserID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	views, err := h.toViews(r, []conversations.Conversation{c})
	if err != nil {
		slog.Error("hydrating dm members failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, views[0])
}

// listMessages handles GET /api/conversations/{id}/messages?before=&limit=.
func (h *ConversationsHandler) listMessages(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	convID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || convID <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid conversation id")
		return
	}

	ok, err := h.convs.IsMember(r.Context(), convID, me.ID)
	if err != nil {
		slog.Error("membership check failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !ok {
		// Indistinguishable from "no such conversation" to avoid
		// enumeration; either way the caller isn't allowed to see it.
		writeJSONError(w, http.StatusNotFound, "conversation not found")
		return
	}

	beforeID, err := parseInt64Query(r, "before", 0)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid before")
		return
	}
	limit, err := parseIntQuery(r, "limit", 0)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid limit")
		return
	}

	rows, err := h.messages.HistoryPage(r.Context(), convID, beforeID, limit)
	if err != nil {
		slog.Error("history page failed", "error", err, "conv_id", convID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	members, err := h.convs.Members(r.Context(), convID)
	if err != nil {
		slog.Error("members for hydration failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]proto.MessageView, len(rows))
	for i, m := range rows {
		out[i] = messageToView(m, members)
	}
	writeJSON(w, http.StatusOK, proto.ListMessagesResponse{Messages: out})
}

// toViews hydrates Conversation rows into ConversationView with member
// lists. One query per conversation — fine at family scale, can be
// batched later if needed.
func (h *ConversationsHandler) toViews(r *http.Request, convs []conversations.Conversation) ([]proto.ConversationView, error) {
	out := make([]proto.ConversationView, 0, len(convs))
	for _, c := range convs {
		members, err := h.convs.Members(r.Context(), c.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, proto.ConversationView{
			ID:        c.ID,
			Type:      c.Type,
			Name:      c.Name,
			CreatedAt: c.CreatedAt.UTC().Format(time.RFC3339Nano),
			Members:   membersToUserInfos(members),
		})
	}
	return out, nil
}

func messageToView(m messages.Message, members []conversations.Member) proto.MessageView {
	return proto.MessageView{
		ID:             m.ID,
		ConversationID: m.ConversationID,
		Sender:         senderInfo(m.SenderID, members),
		Body:           m.Body,
		CreatedAt:      m.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func senderInfo(senderID int64, members []conversations.Member) proto.UserInfo {
	for _, mm := range members {
		if mm.UserID == senderID {
			return proto.UserInfo{
				ID:        mm.UserID,
				Username:  mm.Username,
				CreatedAt: "",
			}
		}
	}
	// Sender no longer a member (left, deleted). Return a best-effort
	// placeholder so the client at least knows it's not malformed.
	return proto.UserInfo{ID: senderID, Username: ""}
}

func membersToUserInfos(members []conversations.Member) []proto.UserInfo {
	out := make([]proto.UserInfo, len(members))
	for i, m := range members {
		out[i] = proto.UserInfo{ID: m.UserID, Username: m.Username, CreatedAt: ""}
	}
	return out
}

// decodeConvJSON is a smaller variant of decodeJSON tuned for these
// endpoints. The auth endpoints have their own size cap.
func decodeConvJSON(body interface{ Read([]byte) (int, error) }, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, &readCloserNoop{body}, maxConvBodyBytes))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// readCloserNoop wraps an io.Reader as a no-op io.ReadCloser so we can
// hand it to http.MaxBytesReader (which insists on ReadCloser).
type readCloserNoop struct {
	r interface{ Read([]byte) (int, error) }
}

func (r *readCloserNoop) Read(p []byte) (int, error) { return r.r.Read(p) }
func (r *readCloserNoop) Close() error               { return nil }

func parseInt64Query(r *http.Request, key string, def int64) (int64, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def, nil
	}
	return strconv.ParseInt(v, 10, 64)
}

func parseIntQuery(r *http.Request, key string, def int) (int, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def, nil
	}
	return strconv.Atoi(v)
}

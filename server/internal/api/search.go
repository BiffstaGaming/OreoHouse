package api

import (
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// SearchHandler serves GET /api/search?q=... — a full-text search
// over every message body AND every attachment filename in
// conversations the caller is a member of. Results are gated
// server-side: the JOIN onto conversation_members ensures users
// can't see hits from convs they don't belong to.
type SearchHandler struct {
	auth        *auth.Service
	convs       *conversations.Service
	messages    *messages.Service
	attachments *attachments.Service
}

// NewSearchHandler wires the services. auth is for the required
// Bearer token check; convs enriches the sender's UserInfo, and
// attachments hydrates the inline file list so a filename match is
// renderable in the UI without a second round-trip.
func NewSearchHandler(
	authSvc *auth.Service,
	convsSvc *conversations.Service,
	msgsSvc *messages.Service,
	attSvc *attachments.Service,
) *SearchHandler {
	return &SearchHandler{
		auth:        authSvc,
		convs:       convsSvc,
		messages:    msgsSvc,
		attachments: attSvc,
	}
}

func (h *SearchHandler) Mount(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(requireAuth(h.auth))
		r.Get("/api/search", h.search)
	})
}

func (h *SearchHandler) search(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	q := r.URL.Query().Get("q")
	if q == "" {
		writeJSONError(w, http.StatusBadRequest, "q parameter is required")
		return
	}
	var convID int64
	if cs := r.URL.Query().Get("conversation_id"); cs != "" {
		v, err := strconv.ParseInt(cs, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid conversation_id")
			return
		}
		convID = v
	}
	limit := 0
	if ls := r.URL.Query().Get("limit"); ls != "" {
		if v, err := strconv.Atoi(ls); err == nil {
			limit = v
		}
	}
	rows, err := h.messages.Search(r.Context(), me.ID, q, convID, limit)
	if err != nil {
		slog.Error("search failed", "error", err, "user_id", me.ID)
		writeJSONError(w, http.StatusInternalServerError, "search failed")
		return
	}

	// Batch-load attachments for every result message so the UI can
	// show "matched: vacation.jpg" rows when the hit was on a filename
	// (or just render the inline image preview alongside a body hit).
	messageIDs := make([]int64, 0, len(rows))
	for _, m := range rows {
		messageIDs = append(messageIDs, m.ID)
	}
	attsByMessage, attErr := h.attachments.ListForMessages(r.Context(), messageIDs)
	if attErr != nil {
		slog.Warn("search: batch attachments lookup failed", "error", attErr)
		attsByMessage = nil
	}

	// Build per-conversation member caches lazily so we don't query
	// the same conv twice. For a 50-row result that touches at most
	// `len(rows)` conversations the user is in.
	memberCache := map[int64][]conversations.Member{}
	out := make([]proto.MessageView, 0, len(rows))
	for _, m := range rows {
		members, ok := memberCache[m.ConversationID]
		if !ok {
			loaded, lerr := h.convs.Members(r.Context(), m.ConversationID)
			if lerr != nil {
				slog.Warn("search: members lookup failed",
					"error", lerr, "conv_id", m.ConversationID)
				continue
			}
			members = loaded
			memberCache[m.ConversationID] = members
		}
		view := proto.MessageView{
			ID:             m.ID,
			ConversationID: m.ConversationID,
			Sender:         senderInfo(m.SenderID, members),
			Body:           m.Body,
			CreatedAt:      m.CreatedAt.UTC().Format(time.RFC3339Nano),
			Attachments:    attachmentsToViews(attsByMessage[m.ID]),
		}
		if !m.EditedAt.IsZero() {
			view.EditedAt = m.EditedAt.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, proto.SearchResponse{Results: out})
}

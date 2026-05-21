package api

import (
	"context"
	"encoding/json"
	"errors"
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

// maxBodyBytes caps the size of any conversations-API JSON body. The
// requests we accept are tiny.
const maxConvBodyBytes = 4 << 10

// Broadcaster is the minimal hub interface this handler uses to push
// membership events. *ws.Hub satisfies it; tests can pass a fake.
type Broadcaster interface {
	SendToUsers(msg []byte, userIDs []int64) []int64
}

// noopBroadcaster is what we install when the handler is constructed
// without a hub (e.g. some tests). It silently drops events.
type noopBroadcaster struct{}

func (noopBroadcaster) SendToUsers(_ []byte, _ []int64) []int64 { return nil }

// ConversationsHandler serves /api/conversations/* endpoints. Construct
// via NewConversationsHandler.
type ConversationsHandler struct {
	auth        *auth.Service
	convs       *conversations.Service
	messages    *messages.Service
	attachments *attachments.Service
	hub         Broadcaster
}

// NewConversationsHandler wires the services together. auth is used
// by the requireAuth middleware. attSvc may be nil for tests that
// don't exercise attachments — message history just omits the
// attachments field in that case. hub may be nil for tests that don't
// care about WS-side broadcasting.
func NewConversationsHandler(
	authSvc *auth.Service,
	convsSvc *conversations.Service,
	msgsSvc *messages.Service,
	attSvc *attachments.Service,
	hub Broadcaster,
) *ConversationsHandler {
	if hub == nil {
		hub = noopBroadcaster{}
	}
	return &ConversationsHandler{
		auth:        authSvc,
		convs:       convsSvc,
		messages:    msgsSvc,
		attachments: attSvc,
		hub:         hub,
	}
}

// Mount registers the /api/conversations/* and /api/rooms/* routes,
// all behind Bearer-token auth.
func (h *ConversationsHandler) Mount(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(requireAuth(h.auth))
		r.Get("/api/conversations", h.list)
		r.Post("/api/conversations/dm", h.createDM)
		r.Post("/api/conversations/group", h.createGroup)
		r.Post("/api/conversations/room", h.createRoom)
		r.Post("/api/conversations/{id}/members", h.addMembers)
		r.Post("/api/conversations/{id}/leave", h.leave)
		r.Get("/api/conversations/{id}/messages", h.listMessages)
		r.Get("/api/conversations/{id}/pins", h.listPins)
		r.Get("/api/conversations/{id}/media", h.listMedia)
		r.Get("/api/conversations/{id}/links", h.listLinks)
		r.Get("/api/rooms", h.listRooms)
		r.Post("/api/rooms/{id}/join", h.joinRoom)
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

	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := h.requireMembership(w, r, convID, me.ID); err != nil {
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

	// Batch-fetch attachments for the page, if the handler has the
	// attachments service wired (nil-safe for tests).
	var attsByMsg map[int64][]attachments.Attachment
	if h.attachments != nil && len(rows) > 0 {
		ids := make([]int64, len(rows))
		for i, m := range rows {
			ids[i] = m.ID
		}
		attsByMsg, err = h.attachments.ListForMessages(r.Context(), ids)
		if err != nil {
			slog.Warn("attachments hydration failed", "error", err)
			attsByMsg = nil // fall through and return without attachments
		}
	}

	// Batch-fetch reactions for the page.
	var reactionsByMsg map[int64][]proto.ReactionGroup
	if len(rows) > 0 {
		ids := make([]int64, len(rows))
		for i, m := range rows {
			ids[i] = m.ID
		}
		rxs, rerr := h.messages.ListReactionsForMessages(r.Context(), ids)
		if rerr != nil {
			slog.Warn("reactions hydration failed", "error", rerr)
		} else {
			reactionsByMsg = groupReactions(rxs)
		}
	}

	out := make([]proto.MessageView, len(rows))
	for i, m := range rows {
		view := messageToView(m, members)
		view.Attachments = attachmentsToViews(attsByMsg[m.ID])
		view.Reactions = reactionsByMsg[m.ID]
		if m.ReplyToID > 0 {
			view.ReplyTo = h.buildReplySnippet(r.Context(), m.ReplyToID, members)
		}
		out[i] = view
	}
	writeJSON(w, http.StatusOK, proto.ListMessagesResponse{Messages: out})
}

// listPins handles GET /api/conversations/{id}/pins. Returns each
// pinned message hydrated with its sender + body (using the same
// member-cache pattern as listMessages). Newest pin first.
func (h *ConversationsHandler) listPins(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := h.requireMembership(w, r, convID, me.ID); err != nil {
		return
	}
	pins, err := h.messages.ListPins(r.Context(), convID)
	if err != nil {
		slog.Error("list pins failed", "error", err, "conv_id", convID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	members, err := h.convs.Members(r.Context(), convID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]proto.PinView, 0, len(pins))
	for _, p := range pins {
		msg, err := h.messages.Get(r.Context(), p.MessageID)
		if err != nil {
			// Pin row got orphaned by ON DELETE CASCADE; skip.
			continue
		}
		out = append(out, proto.PinView{
			Message:  messageToView(msg, members),
			PinnedBy: senderInfo(p.PinnedBy, members),
			PinnedAt: p.PinnedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	writeJSON(w, http.StatusOK, proto.ListPinsResponse{Pins: out})
}

// listMedia handles GET /api/conversations/{id}/media. Returns every
// attachment linked to a non-deleted message in the conversation,
// newest-first, hydrated with the sender + the original message id
// so the client can jump back to context.
func (h *ConversationsHandler) listMedia(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := h.requireMembership(w, r, convID, me.ID); err != nil {
		return
	}
	limit := 200
	if ls := r.URL.Query().Get("limit"); ls != "" {
		if v, err := strconv.Atoi(ls); err == nil && v > 0 && v <= 500 {
			limit = v
		}
	}
	rows, err := h.attachments.ListForConversation(r.Context(), convID, limit)
	if err != nil {
		slog.Error("list media failed", "error", err, "conv_id", convID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	members, err := h.convs.Members(r.Context(), convID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	// Resolve each attachment's sender via the message it's linked to.
	// We need uploader_id here, not message_id — uploads happen before
	// the message exists, so uploader_id is the source of truth for
	// "who shared this file."
	out := make([]proto.MediaItem, 0, len(rows))
	for _, a := range rows {
		out = append(out, proto.MediaItem{
			Attachment: attachmentToView(a),
			MessageID:  a.MessageID,
			Sender:     senderInfo(a.UploaderID, members),
			CreatedAt:  a.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	writeJSON(w, http.StatusOK, proto.ListMediaResponse{Items: out})
}

// listLinks handles GET /api/conversations/{id}/links. Walks the
// most recent N messages and extracts http(s) URLs from each body.
func (h *ConversationsHandler) listLinks(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := h.requireMembership(w, r, convID, me.ID); err != nil {
		return
	}
	limit := 500
	if ls := r.URL.Query().Get("limit"); ls != "" {
		if v, err := strconv.Atoi(ls); err == nil && v > 0 && v <= 1000 {
			limit = v
		}
	}
	links, err := h.messages.ListLinksInConversation(r.Context(), convID, limit)
	if err != nil {
		slog.Error("list links failed", "error", err, "conv_id", convID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	members, err := h.convs.Members(r.Context(), convID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]proto.LinkItem, 0, len(links))
	for _, l := range links {
		out = append(out, proto.LinkItem{
			URL:            l.URL,
			MessageID:      l.MessageID,
			ConversationID: l.ConversationID,
			Sender:         senderInfo(l.SenderID, members),
			CreatedAt:      l.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, proto.ListLinksResponse{Items: out})
}

// buildReplySnippet — REST-side variant of the WS handler's helper.
// Returns nil on lookup failure so the client falls back to "(replied
// to a deleted message)" gracefully when reply_to_id dangles after a
// delete cascade.
func (h *ConversationsHandler) buildReplySnippet(
	ctx context.Context, replyToID int64, members []conversations.Member,
) *proto.ReplySnippet {
	if replyToID <= 0 {
		return nil
	}
	parent, err := h.messages.Get(ctx, replyToID)
	if err != nil {
		return nil
	}
	const previewBytes = 160
	body := parent.Body
	deleted := !parent.DeletedAt.IsZero()
	if deleted {
		body = ""
	}
	if len(body) > previewBytes {
		body = body[:previewBytes]
	}
	return &proto.ReplySnippet{
		ID:      parent.ID,
		Sender:  senderInfo(parent.SenderID, members),
		Body:    body,
		Deleted: deleted,
	}
}

// groupReactions folds a flat list of (message, user, emoji) rows
// into per-message arrays of {emoji, user_ids[]} ordered by emoji.
// Stable within an emoji by user_id ascending.
func groupReactions(rxs []messages.Reaction) map[int64][]proto.ReactionGroup {
	// message_id -> emoji -> []user_id
	byMsg := map[int64]map[string][]int64{}
	for _, r := range rxs {
		inner, ok := byMsg[r.MessageID]
		if !ok {
			inner = map[string][]int64{}
			byMsg[r.MessageID] = inner
		}
		inner[r.Emoji] = append(inner[r.Emoji], r.UserID)
	}
	out := make(map[int64][]proto.ReactionGroup, len(byMsg))
	for msgID, inner := range byMsg {
		groups := make([]proto.ReactionGroup, 0, len(inner))
		for emoji, uids := range inner {
			groups = append(groups, proto.ReactionGroup{
				Emoji:   emoji,
				UserIDs: uids,
			})
		}
		// Stable order so identical messages produce identical bytes.
		sortReactionGroups(groups)
		out[msgID] = groups
	}
	return out
}

func sortReactionGroups(g []proto.ReactionGroup) {
	for i := 1; i < len(g); i++ {
		for j := i; j > 0 && g[j-1].Emoji > g[j].Emoji; j-- {
			g[j-1], g[j] = g[j], g[j-1]
		}
	}
}

// attachmentsToViews maps attachments.Attachment to AttachmentView.
// Returns nil for an empty input so the JSON omitempty kicks in.
func attachmentsToViews(rows []attachments.Attachment) []proto.AttachmentView {
	if len(rows) == 0 {
		return nil
	}
	out := make([]proto.AttachmentView, len(rows))
	for i, a := range rows {
		out[i] = proto.AttachmentView{
			ID:          a.ID,
			Filename:    a.Filename,
			MimeType:    a.MimeType,
			SizeBytes:   a.SizeBytes,
			ImageWidth:  a.ImageWidth,
			ImageHeight: a.ImageHeight,
		}
	}
	return out
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
			Topic:     c.Topic,
			CreatedAt: c.CreatedAt.UTC().Format(time.RFC3339Nano),
			Members:   membersToUserInfos(members),
		})
	}
	return out, nil
}

// createGroup handles POST /api/conversations/group.
func (h *ConversationsHandler) createGroup(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	var req proto.CreateGroupRequest
	if err := decodeConvJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	c, err := h.convs.CreateGroup(r.Context(), me.ID, req.Name, req.MemberIDs)
	if errors.Is(err, conversations.ErrInvalidName) ||
		errors.Is(err, conversations.ErrNoMembers) {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		slog.Error("create group failed", "error", err, "user_id", me.ID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	views, err := h.toViews(r, []conversations.Conversation{c})
	if err != nil {
		slog.Error("hydrating group failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	// All members are new (the group is brand new) → push
	// conversation_added to every member. No members_changed because
	// nobody had this conversation before.
	h.pushConversationAdded(views[0], memberIDs(views[0]))
	writeJSON(w, http.StatusOK, views[0])
}

// createRoom handles POST /api/conversations/room.
func (h *ConversationsHandler) createRoom(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())

	var req proto.CreateRoomRequest
	if err := decodeConvJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	c, err := h.convs.CreateRoom(r.Context(), me.ID, req.Name, req.Topic)
	if errors.Is(err, conversations.ErrInvalidName) ||
		errors.Is(err, conversations.ErrInvalidTopic) {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		slog.Error("create room failed", "error", err, "user_id", me.ID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	views, err := h.toViews(r, []conversations.Conversation{c})
	if err != nil {
		slog.Error("hydrating room failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	h.pushConversationAdded(views[0], []int64{me.ID})
	writeJSON(w, http.StatusOK, views[0])
}

// addMembers handles POST /api/conversations/{id}/members. The caller
// must be a member of the target conversation (which must be a group;
// rooms use POST /api/rooms/{id}/join).
func (h *ConversationsHandler) addMembers(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}

	conv, err := h.convs.Get(r.Context(), convID)
	if errors.Is(err, conversations.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "conversation not found")
		return
	}
	if err != nil {
		slog.Error("addMembers get conversation failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if conv.Type != conversations.TypeGroup {
		writeJSONError(w, http.StatusBadRequest, "members can only be added to groups; use /api/rooms/{id}/join for rooms")
		return
	}

	if err := h.requireMembership(w, r, conv.ID, me.ID); err != nil {
		return
	}

	var req proto.AddMembersRequest
	if err := decodeConvJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.UserIDs) == 0 {
		writeJSONError(w, http.StatusBadRequest, "user_ids is required")
		return
	}

	// Snapshot the existing membership so we can tell new vs old.
	before, err := h.convs.Members(r.Context(), conv.ID)
	if err != nil {
		slog.Error("members before snapshot failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	beforeIDs := make(map[int64]bool, len(before))
	for _, m := range before {
		beforeIDs[m.UserID] = true
	}

	for _, uid := range req.UserIDs {
		if err := h.convs.AddMember(r.Context(), conv.ID, uid); err != nil {
			slog.Error("AddMember failed", "error", err, "conv_id", conv.ID, "user_id", uid)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}

	views, err := h.toViews(r, []conversations.Conversation{conv})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	view := views[0]

	// Newly-added (not in before snapshot) → conversation_added.
	// Pre-existing → conversation_members_changed.
	var newUsers, oldUsers []int64
	for _, m := range view.Members {
		if beforeIDs[m.ID] {
			oldUsers = append(oldUsers, m.ID)
		} else {
			newUsers = append(newUsers, m.ID)
		}
	}
	h.pushConversationAdded(view, newUsers)
	h.pushMembersChanged(view, oldUsers)

	writeJSON(w, http.StatusOK, view)
}

// leave handles POST /api/conversations/{id}/leave. DMs can't be left.
func (h *ConversationsHandler) leave(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}

	conv, err := h.convs.Get(r.Context(), convID)
	if errors.Is(err, conversations.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "conversation not found")
		return
	}
	if err != nil {
		slog.Error("leave get conversation failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if conv.Type == conversations.TypeDM {
		writeJSONError(w, http.StatusBadRequest, "cannot leave a DM")
		return
	}
	if err := h.requireMembership(w, r, conv.ID, me.ID); err != nil {
		return
	}

	if err := h.convs.RemoveMember(r.Context(), conv.ID, me.ID); err != nil {
		slog.Error("RemoveMember failed", "error", err, "conv_id", conv.ID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Tell whoever's left about the new member list.
	views, err := h.toViews(r, []conversations.Conversation{conv})
	if err == nil {
		view := views[0]
		h.pushMembersChanged(view, memberIDs(view))
	}
	w.WriteHeader(http.StatusNoContent)
}

// listRooms handles GET /api/rooms.
func (h *ConversationsHandler) listRooms(w http.ResponseWriter, r *http.Request) {
	rooms, err := h.convs.ListRooms(r.Context())
	if err != nil {
		slog.Error("listRooms failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]proto.RoomView, len(rooms))
	for i, room := range rooms {
		out[i] = proto.RoomView{
			ID:          room.ID,
			Name:        room.Name,
			Topic:       room.Topic,
			CreatedAt:   room.CreatedAt.UTC().Format(time.RFC3339Nano),
			MemberCount: room.MemberCount,
		}
	}
	writeJSON(w, http.StatusOK, proto.ListRoomsResponse{Rooms: out})
}

// joinRoom handles POST /api/rooms/{id}/join. Idempotent — joining a
// room you're already in just returns the conversation.
func (h *ConversationsHandler) joinRoom(w http.ResponseWriter, r *http.Request) {
	me, _ := UserFromContext(r.Context())
	convID, ok := parseIDParam(w, r, "id")
	if !ok {
		return
	}

	conv, err := h.convs.Get(r.Context(), convID)
	if errors.Is(err, conversations.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "room not found")
		return
	}
	if err != nil {
		slog.Error("joinRoom get failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if conv.Type != conversations.TypeRoom {
		writeJSONError(w, http.StatusBadRequest, "conversation is not a room")
		return
	}

	// Snapshot members before join so we can tell whether this is a
	// new membership (push conversation_added) or a re-join (no-op
	// for events).
	before, err := h.convs.Members(r.Context(), conv.ID)
	if err != nil {
		slog.Error("joinRoom members snapshot failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	wasMember := false
	for _, m := range before {
		if m.UserID == me.ID {
			wasMember = true
			break
		}
	}

	if err := h.convs.AddMember(r.Context(), conv.ID, me.ID); err != nil {
		slog.Error("AddMember (join) failed", "error", err, "room_id", conv.ID)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	views, err := h.toViews(r, []conversations.Conversation{conv})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	view := views[0]

	if !wasMember {
		h.pushConversationAdded(view, []int64{me.ID})
		oldIDs := make([]int64, 0, len(before))
		for _, m := range before {
			oldIDs = append(oldIDs, m.UserID)
		}
		h.pushMembersChanged(view, oldIDs)
	}

	writeJSON(w, http.StatusOK, view)
}

// pushConversationAdded marshals a conversation_added envelope and
// hands it to the hub, scoped to userIDs. No-op if userIDs is empty.
func (h *ConversationsHandler) pushConversationAdded(view proto.ConversationView, userIDs []int64) {
	if len(userIDs) == 0 {
		return
	}
	msg := proto.ConversationAddedMessage{
		Type:         proto.TypeConversationAdded,
		Conversation: view,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		slog.Error("marshal conversation_added failed", "error", err)
		return
	}
	h.hub.SendToUsers(b, userIDs)
}

// pushMembersChanged marshals a conversation_members_changed envelope
// and sends it to userIDs. No-op if userIDs is empty.
func (h *ConversationsHandler) pushMembersChanged(view proto.ConversationView, userIDs []int64) {
	if len(userIDs) == 0 {
		return
	}
	msg := proto.ConversationMembersChangedMessage{
		Type:           proto.TypeConversationMembersChanged,
		ConversationID: view.ID,
		Members:        view.Members,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		slog.Error("marshal members_changed failed", "error", err)
		return
	}
	h.hub.SendToUsers(b, userIDs)
}

func memberIDs(view proto.ConversationView) []int64 {
	out := make([]int64, len(view.Members))
	for i, m := range view.Members {
		out[i] = m.ID
	}
	return out
}

// requireMembership writes a 404 and returns a non-nil error if the
// user isn't a member of the given conversation. 404 (not 403) so
// callers can't enumerate conversation IDs they shouldn't see.
func (h *ConversationsHandler) requireMembership(w http.ResponseWriter, r *http.Request, convID, userID int64) error {
	ok, err := h.convs.IsMember(r.Context(), convID, userID)
	if err != nil {
		slog.Error("membership check failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return err
	}
	if !ok {
		writeJSONError(w, http.StatusNotFound, "conversation not found")
		return errors.New("not a member")
	}
	return nil
}

func parseIDParam(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, key), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	return id, true
}

func messageToView(m messages.Message, members []conversations.Member) proto.MessageView {
	v := proto.MessageView{
		ID:             m.ID,
		ConversationID: m.ConversationID,
		Sender:         senderInfo(m.SenderID, members),
		Body:           m.Body,
		CreatedAt:      m.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !m.EditedAt.IsZero() {
		v.EditedAt = m.EditedAt.UTC().Format(time.RFC3339Nano)
	}
	if !m.DeletedAt.IsZero() {
		v.DeletedAt = m.DeletedAt.UTC().Format(time.RFC3339Nano)
	}
	return v
}

func senderInfo(senderID int64, members []conversations.Member) proto.UserInfo {
	for _, mm := range members {
		if mm.UserID == senderID {
			return memberToUserInfo(mm)
		}
	}
	// Sender no longer a member (left, deleted). Return a best-effort
	// placeholder so the client at least knows it's not malformed.
	return proto.UserInfo{ID: senderID, Username: ""}
}

func membersToUserInfos(members []conversations.Member) []proto.UserInfo {
	out := make([]proto.UserInfo, len(members))
	for i, m := range members {
		out[i] = memberToUserInfo(m)
	}
	return out
}

// memberToUserInfo flattens a conversations.Member into the public
// UserInfo wire shape. CreatedAt isn't carried on Members (the column
// isn't joined) so it's left empty — clients fall back to whatever
// they have cached via presence / welcome.
func memberToUserInfo(m conversations.Member) proto.UserInfo {
	return proto.UserInfo{
		ID:            m.UserID,
		Username:      m.Username,
		CreatedAt:     "",
		DisplayName:   m.DisplayName,
		HasAvatar:     m.AvatarAttachmentID > 0,
		AvatarVersion: m.AvatarAttachmentID,
	}
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

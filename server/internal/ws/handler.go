package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// shutdownDrain is how long we wait for queued outbound messages to
// flush after the connection ends before forcing the writer to exit.
const shutdownDrain = 2 * time.Second

// Handler is the http.Handler for /ws. It authenticates via the
// ?token= query parameter, upgrades the connection, and runs the
// per-connection lifecycle (welcome → presence broadcast → missed-
// message replay → read/write pumps → presence offline + last_seen_at
// update on disconnect).
type Handler struct {
	hub         *Hub
	auth        *auth.Service
	convs       *conversations.Service
	messages    *messages.Service
	attachments *attachments.Service
}

// NewHandler wires the Hub and the auth/conversations/messages/
// attachments services into an http.Handler.
func NewHandler(
	hub *Hub,
	authSvc *auth.Service,
	convsSvc *conversations.Service,
	msgsSvc *messages.Service,
	attSvc *attachments.Service,
) *Handler {
	return &Handler{
		hub:         hub,
		auth:        authSvc,
		convs:       convsSvc,
		messages:    msgsSvc,
		attachments: attSvc,
	}
}

// ServeHTTP authenticates the request and, on success, hands the
// upgraded connection over to serve.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	user, _, err := h.auth.LookupSession(r.Context(), token)
	if errors.Is(err, auth.ErrSessionNotFound) || errors.Is(err, auth.ErrSessionExpired) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err != nil {
		slog.Error("ws: session lookup failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// LAN-only deployment + Tauri client uses a custom-protocol
		// origin. Phase 2 keeps the Phase 0 stance.
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("ws: accept failed", "error", err)
		return
	}

	h.serve(r.Context(), conn, user)
}

// serve runs the full per-connection lifecycle. It returns when the
// connection ends, after which all background goroutines have either
// exited or been given up on.
func (h *Handler) serve(parentCtx context.Context, conn *websocket.Conn, user auth.User) {
	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()

	defer conn.Close(websocket.StatusInternalError, "internal error")

	client := newClient(user, 16)

	firstConn := h.hub.Register(client)
	defer func() {
		lastConn := h.hub.Unregister(client)
		if lastConn {
			h.broadcastPresence(user, proto.StateOffline, "")
			// Best-effort last_seen update. Use a fresh background
			// context — the request context may already be cancelled.
			bg, bgCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer bgCancel()
			if err := h.auth.UpdateLastSeen(bg, user.ID, time.Now().UTC()); err != nil {
				slog.Warn("ws: update last_seen failed", "error", err, "user_id", user.ID)
			}
		}
	}()

	// Seed discrete state for this user's first connection. Custom
	// text persists across sessions (loaded from DB); state defaults
	// to "online" each new session.
	if firstConn {
		text, err := h.auth.GetStatusText(ctx, user.ID)
		if err != nil {
			slog.Warn("ws: load status_text failed", "error", err, "user_id", user.ID)
		}
		h.hub.SetPresence(user.ID, proto.StateOnline, text)
	}

	// Welcome is sent inline (no writer goroutine yet) — it's safe
	// because we're the only writer on this connection at this point.
	if err := h.sendWelcome(ctx, conn, user); err != nil {
		slog.Info("ws: welcome write failed", "error", err, "user_id", user.ID)
		return
	}

	if firstConn {
		// Use the seeded state for the broadcast — text from DB,
		// state defaults to online (we just set it).
		_, text, _ := h.currentPresence(user.ID)
		h.broadcastPresence(user, proto.StateOnline, text)
	}

	// Replay any messages that arrived while the user was offline,
	// in-order, before the writer starts so live broadcasts can't
	// interleave with the catch-up.
	if err := h.replayMissed(ctx, conn, user); err != nil {
		slog.Warn("ws: replay failed", "error", err, "user_id", user.ID)
		// continue anyway — the user can still chat live
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		h.writer(ctx, conn, client)
	}()

	h.reader(ctx, conn, client)

	// Reader returned — close the writer and give it a moment to
	// drain any queued messages before forcing exit.
	cancel()
	select {
	case <-writerDone:
	case <-time.After(shutdownDrain):
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
}

func (h *Handler) sendWelcome(ctx context.Context, conn *websocket.Conn, user auth.User) error {
	reads, err := h.messages.ListReadsForUser(ctx, user.ID)
	if err != nil {
		// Non-fatal — clients can still render the chat without an
		// initial read-state snapshot; live read_receipt events will
		// fill it in. Log but continue.
		slog.Error("ws: hydrate reads failed", "error", err, "user_id", user.ID)
		reads = nil
	}
	views := make([]proto.ReadStateView, 0, len(reads))
	for _, r := range reads {
		views = append(views, proto.ReadStateView{
			ConversationID:    r.ConversationID,
			UserID:            r.UserID,
			LastReadMessageID: r.LastReadMessageID,
			At:                r.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	msg := proto.WelcomeMessage{
		Type:   proto.TypeWelcome,
		You:    userToInfo(user),
		Online: presenceToInfos(h.hub.OnlineUsers()),
		Reads:  views,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

func (h *Handler) broadcastPresence(user auth.User, state, customText string) {
	msg := proto.PresenceMessage{
		Type:       proto.TypePresence,
		User:       userToInfo(user),
		State:      state,
		CustomText: customText,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		slog.Error("ws: marshal presence failed", "error", err)
		return
	}
	h.hub.Broadcast(b)
}

// currentPresence reads the live hub-tracked state for userID via a
// snapshot. Returns (state, customText, ok). ok is false when the
// user is no longer online.
func (h *Handler) currentPresence(userID int64) (string, string, bool) {
	for _, p := range h.hub.OnlineUsers() {
		if p.User.ID == userID {
			return p.State, p.CustomText, true
		}
	}
	return "", "", false
}

// reader runs on the request goroutine. It returns when the
// connection ends (either side closes, or a protocol violation forces
// us to bail). Read-side errors are logged at INFO since they're
// usually just the client disconnecting.
func (h *Handler) reader(ctx context.Context, conn *websocket.Conn, c *Client) {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			slog.Info("ws: client disconnected", "user_id", c.user.ID, "error", err)
			return
		}
		var env proto.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "expected JSON object with a type field")
			return
		}
		switch env.Type {
		case proto.TypePing:
			pong, _ := json.Marshal(proto.PongMessage{Type: proto.TypePong})
			h.queueSend(c, pong)
		case proto.TypeMessage:
			h.handleIncomingMessage(ctx, c, data)
		case proto.TypeStatus:
			h.handleStatus(ctx, c, data)
		case proto.TypeTyping:
			h.handleTyping(ctx, c, data)
		case proto.TypeNudge:
			h.handleNudge(ctx, c, data)
		case proto.TypeRead:
			h.handleRead(ctx, c, data)
		case proto.TypeReact:
			h.handleReact(ctx, c, data)
		default:
			// Unknown / reserved types are silently ignored for
			// forward-compatibility. See docs/protocol.md.
		}
	}
}

// handleTyping fans a typing event out to every other member of the
// target conversation. The server doesn't persist or rate-limit
// these — that's the client's job (~one event per 2 s).
func (h *Handler) handleTyping(ctx context.Context, c *Client, raw []byte) {
	var in proto.IncomingTypingMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		// Silent on malformed typing — it's a UX signal, not worth
		// surfacing as an error.
		return
	}
	if in.ConversationID <= 0 {
		return
	}
	ok, err := h.convs.IsMember(ctx, in.ConversationID, c.user.ID)
	if err != nil || !ok {
		return
	}
	members, err := h.convs.Members(ctx, in.ConversationID)
	if err != nil {
		return
	}
	out := proto.TypingMessage{
		Type:           proto.TypeTyping,
		ConversationID: in.ConversationID,
		User:           userToInfo(c.user),
	}
	b, err := json.Marshal(out)
	if err != nil {
		return
	}
	otherIDs := make([]int64, 0, len(members)-1)
	for _, m := range members {
		if m.UserID == c.user.ID {
			continue
		}
		otherIDs = append(otherIDs, m.UserID)
	}
	h.hub.SendToUsers(b, otherIDs)
}

// handleNudge fans a nudge out to every other member of the target
// conversation. Like typing, the server doesn't persist or rate-limit
// — clients enforce a UX cooldown on the send side.
func (h *Handler) handleNudge(ctx context.Context, c *Client, raw []byte) {
	var in proto.IncomingNudgeMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "invalid nudge body")
		return
	}
	if in.ConversationID <= 0 {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "conversation_id is required")
		return
	}
	ok, err := h.convs.IsMember(ctx, in.ConversationID, c.user.ID)
	if err != nil {
		slog.Error("ws: nudge membership check failed", "error", err)
		return
	}
	if !ok {
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "not a member of conversation")
		return
	}
	members, err := h.convs.Members(ctx, in.ConversationID)
	if err != nil {
		return
	}
	out := proto.NudgeMessage{
		Type:           proto.TypeNudge,
		ConversationID: in.ConversationID,
		Sender:         userToInfo(c.user),
	}
	b, err := json.Marshal(out)
	if err != nil {
		return
	}
	otherIDs := make([]int64, 0, len(members)-1)
	for _, m := range members {
		if m.UserID == c.user.ID {
			continue
		}
		otherIDs = append(otherIDs, m.UserID)
	}
	h.hub.SendToUsers(b, otherIDs)
}

// handleRead persists the sender's read cursor for a conversation and,
// if the cursor advanced, broadcasts a read_receipt to the OTHER
// members so their UIs can render tick marks.
func (h *Handler) handleRead(ctx context.Context, c *Client, raw []byte) {
	var in proto.IncomingReadMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		// Read receipts are advisory — don't surface protocol errors.
		return
	}
	if in.ConversationID <= 0 || in.LastReadMessageID <= 0 {
		return
	}
	ok, err := h.convs.IsMember(ctx, in.ConversationID, c.user.ID)
	if err != nil || !ok {
		return
	}
	changed, err := h.messages.MarkConversationRead(
		ctx, in.ConversationID, c.user.ID, in.LastReadMessageID,
	)
	if err != nil {
		slog.Error("ws: mark read failed", "error", err, "user_id", c.user.ID)
		return
	}
	if !changed {
		return
	}
	members, err := h.convs.Members(ctx, in.ConversationID)
	if err != nil {
		return
	}
	out := proto.ReadReceiptMessage{
		Type:              proto.TypeReadReceipt,
		ConversationID:    in.ConversationID,
		User:              userToInfo(c.user),
		LastReadMessageID: in.LastReadMessageID,
		At:                time.Now().UTC().Format(time.RFC3339Nano),
	}
	b, err := json.Marshal(out)
	if err != nil {
		return
	}
	otherIDs := make([]int64, 0, len(members)-1)
	for _, m := range members {
		if m.UserID == c.user.ID {
			continue
		}
		otherIDs = append(otherIDs, m.UserID)
	}
	h.hub.SendToUsers(b, otherIDs)
}

// handleReact toggles a reaction on a message and, on success,
// broadcasts a reaction event to every member of the message's
// conversation. The sender's own UI updates from the echo (one path
// for all renders).
func (h *Handler) handleReact(ctx context.Context, c *Client, raw []byte) {
	var in proto.IncomingReactMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "invalid react body")
		return
	}
	if in.MessageID <= 0 || in.Emoji == "" {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "message_id and emoji are required")
		return
	}
	msg, err := h.messages.Get(ctx, in.MessageID)
	if errors.Is(err, messages.ErrNotFound) {
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "message not found")
		return
	}
	if err != nil {
		slog.Error("ws: react message lookup failed", "error", err)
		return
	}
	ok, err := h.convs.IsMember(ctx, msg.ConversationID, c.user.ID)
	if err != nil || !ok {
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "not a member of conversation")
		return
	}
	action, err := h.messages.ToggleReaction(ctx, in.MessageID, c.user.ID, in.Emoji)
	if errors.Is(err, messages.ErrEmojiTooLong) {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, err.Error())
		return
	}
	if err != nil {
		slog.Error("ws: toggle reaction failed", "error", err)
		return
	}
	members, err := h.convs.Members(ctx, msg.ConversationID)
	if err != nil {
		return
	}
	out := proto.ReactionMessage{
		Type:           proto.TypeReaction,
		MessageID:      in.MessageID,
		ConversationID: msg.ConversationID,
		User:           userToInfo(c.user),
		Emoji:          in.Emoji,
		Action:         string(action),
	}
	b, err := json.Marshal(out)
	if err != nil {
		return
	}
	memberIDs := make([]int64, 0, len(members))
	for _, m := range members {
		memberIDs = append(memberIDs, m.UserID)
	}
	h.hub.SendToUsers(b, memberIDs)
}

// handleStatus updates the sender's discrete state and custom text.
// On a real change, the new presence is broadcast to all connected
// clients (so contact lists update live). Custom text is persisted
// in the users table so it survives reconnects.
func (h *Handler) handleStatus(ctx context.Context, c *Client, raw []byte) {
	var in proto.StatusMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "invalid status body")
		return
	}
	if !proto.ValidUserState(in.State) {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "invalid state value")
		return
	}
	const maxStatusTextBytes = 256
	if len(in.CustomText) > maxStatusTextBytes {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage,
			"custom_text exceeds 256 bytes")
		return
	}

	if err := h.auth.SetStatusText(ctx, c.user.ID, in.CustomText); err != nil {
		slog.Error("ws: set status_text failed", "error", err, "user_id", c.user.ID)
		// Don't bail — in-memory update is more important than persistence
	}
	changed := h.hub.SetPresence(c.user.ID, in.State, in.CustomText)
	if changed {
		h.broadcastPresence(c.user, in.State, in.CustomText)
	}
}

// handleIncomingMessage validates and persists a client→server
// "message", then broadcasts the resulting OutgoingMessage to all
// conversation members (including the sender, so the sender's UI
// adds the row via the same path everyone else does).
//
// Protocol violations are reported via an in-band error message but
// do NOT close the connection — the client can correct and retry.
func (h *Handler) handleIncomingMessage(ctx context.Context, c *Client, raw []byte) {
	var in proto.IncomingMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "invalid message body")
		return
	}
	if in.ConversationID <= 0 {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "conversation_id is required")
		return
	}
	if in.Body == "" && len(in.AttachmentIDs) == 0 {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "message must have a body or attachments")
		return
	}
	if err := messages.ValidateBody(in.Body); err != nil {
		h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, err.Error())
		return
	}
	ok, err := h.convs.IsMember(ctx, in.ConversationID, c.user.ID)
	if err != nil {
		slog.Error("ws: membership check failed", "error", err)
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "internal error")
		return
	}
	if !ok {
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "not a member of conversation")
		return
	}

	// Pre-validate attachments so we don't persist a message we can't
	// fully back up. Each must exist, be owned by the sender, and not
	// already be linked to a message.
	preValidated := make([]attachments.Attachment, 0, len(in.AttachmentIDs))
	for _, aid := range in.AttachmentIDs {
		a, err := h.attachments.Get(ctx, aid)
		if errors.Is(err, attachments.ErrNotFound) {
			h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "unknown attachment")
			return
		}
		if err != nil {
			slog.Error("ws: attachment lookup failed", "error", err, "attachment_id", aid)
			h.sendErrorAsync(c, proto.ErrCodeForbidden, "internal error")
			return
		}
		if a.UploaderID != c.user.ID {
			h.sendErrorAsync(c, proto.ErrCodeForbidden, "attachment belongs to a different user")
			return
		}
		if a.MessageID != 0 {
			h.sendErrorAsync(c, proto.ErrCodeInvalidMessage, "attachment already linked to a message")
			return
		}
		preValidated = append(preValidated, a)
	}

	persisted, err := h.messages.Send(ctx, in.ConversationID, c.user.ID, in.Body)
	if err != nil {
		slog.Error("ws: message persist failed", "error", err)
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "internal error")
		return
	}

	// Link the (already-validated) attachments. Any failure here is
	// logged but doesn't abort the broadcast — the message is in the
	// DB and the user expects feedback.
	for _, a := range preValidated {
		if err := h.attachments.Attach(ctx, a.ID, persisted.ID, c.user.ID); err != nil {
			slog.Warn("ws: attach failed post-persist", "error", err,
				"message_id", persisted.ID, "attachment_id", a.ID)
		}
	}

	members, err := h.convs.Members(ctx, in.ConversationID)
	if err != nil {
		slog.Error("ws: members lookup failed", "error", err, "conv_id", in.ConversationID)
		return
	}
	out := proto.OutgoingMessage{
		Type:           proto.TypeMessage,
		ID:             persisted.ID,
		ConversationID: persisted.ConversationID,
		Sender:         userToInfo(c.user),
		Body:           persisted.Body,
		CreatedAt:      persisted.CreatedAt.UTC().Format(time.RFC3339Nano),
		Attachments:    attachmentsToViews(preValidated),
	}
	b, err := json.Marshal(out)
	if err != nil {
		slog.Error("ws: marshal outgoing message failed", "error", err)
		return
	}

	memberIDs := make([]int64, 0, len(members))
	for _, m := range members {
		memberIDs = append(memberIDs, m.UserID)
	}
	delivered := h.hub.SendToUsers(b, memberIDs)

	// Advance the delivery cursor for online recipients so the next
	// replay-on-reconnect doesn't re-send what they already saw.
	for _, uid := range delivered {
		if err := h.convs.UpdateLastDelivered(ctx, in.ConversationID, uid, persisted.ID); err != nil {
			slog.Warn("ws: update last_delivered failed",
				"error", err, "conv_id", in.ConversationID, "user_id", uid)
		}
	}
}

// replayMissed sends OutgoingMessage events for any messages the user
// missed while offline, in chronological order, and advances their
// per-conversation delivery cursor to the highest id sent. Runs
// inline before the writer goroutine starts, so live broadcasts can't
// interleave with the catch-up.
func (h *Handler) replayMissed(ctx context.Context, conn *websocket.Conn, user auth.User) error {
	convs, err := h.convs.ListForUser(ctx, user.ID)
	if err != nil {
		return err
	}
	for _, c := range convs {
		lastID, err := h.convs.LastDelivered(ctx, c.ID, user.ID)
		if err != nil {
			slog.Warn("ws: replay LastDelivered failed", "error", err, "conv_id", c.ID)
			continue
		}
		missed, err := h.messages.Since(ctx, c.ID, lastID, 0)
		if err != nil {
			slog.Warn("ws: replay Since failed", "error", err, "conv_id", c.ID)
			continue
		}
		if len(missed) == 0 {
			continue
		}
		members, err := h.convs.Members(ctx, c.ID)
		if err != nil {
			slog.Warn("ws: replay Members failed", "error", err, "conv_id", c.ID)
			continue
		}
		// Batch-load attachments for the whole replay page so we
		// don't do N queries per conversation.
		messageIDs := make([]int64, 0, len(missed))
		for _, m := range missed {
			messageIDs = append(messageIDs, m.ID)
		}
		attsByMessage, err := h.attachments.ListForMessages(ctx, messageIDs)
		if err != nil {
			slog.Warn("ws: replay attachments lookup failed", "error", err, "conv_id", c.ID)
			attsByMessage = nil
		}
		maxID := lastID
		for _, m := range missed {
			out := proto.OutgoingMessage{
				Type:           proto.TypeMessage,
				ID:             m.ID,
				ConversationID: m.ConversationID,
				Sender:         senderUserInfo(m.SenderID, members),
				Body:           m.Body,
				CreatedAt:      m.CreatedAt.UTC().Format(time.RFC3339Nano),
				Attachments:    attachmentsToViews(attsByMessage[m.ID]),
			}
			b, err := json.Marshal(out)
			if err != nil {
				continue
			}
			if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
				return err
			}
			if m.ID > maxID {
				maxID = m.ID
			}
		}
		if maxID > lastID {
			if err := h.convs.UpdateLastDelivered(ctx, c.ID, user.ID, maxID); err != nil {
				slog.Warn("ws: replay update last_delivered failed", "error", err)
			}
		}
	}
	return nil
}

// senderUserInfo returns the proto.UserInfo for senderID by looking it
// up in members; falls back to a sparse placeholder if the sender is
// no longer in the conversation (left, deleted).
func senderUserInfo(senderID int64, members []conversations.Member) proto.UserInfo {
	for _, m := range members {
		if m.UserID == senderID {
			return proto.UserInfo{ID: m.UserID, Username: m.Username}
		}
	}
	return proto.UserInfo{ID: senderID}
}

// attachmentsToViews maps service-level Attachment rows to the proto
// shape sent over the wire. Returns nil for an empty slice so the
// JSON omitempty kicks in.
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

// writer runs on its own goroutine and is the only thing that calls
// conn.Write after the welcome. Exits when ctx is cancelled or the
// send channel is closed.
func (h *Handler) writer(ctx context.Context, conn *websocket.Conn, c *Client) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
				return
			}
		}
	}
}

// queueSend tries to put msg on the client's send buffer. If the
// buffer is full, the message is dropped — the slow-client problem
// is the slow client's problem, not the hub's.
func (h *Handler) queueSend(c *Client, msg []byte) {
	select {
	case c.send <- msg:
	default:
		slog.Warn("ws: client send buffer full, dropping message", "user_id", c.user.ID)
	}
}

// sendErrorAsync queues an error message via the client's send buffer
// (so we don't double-write on the connection). The reader can then
// return, and the connection will close cleanly.
func (h *Handler) sendErrorAsync(c *Client, code, message string) {
	msg := proto.ErrorMessage{Type: proto.TypeError, Code: code, Message: message}
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.queueSend(c, b)
}

func userToInfo(u auth.User) proto.UserInfo {
	return proto.UserInfo{
		ID:            u.ID,
		Username:      u.Username,
		CreatedAt:     u.CreatedAt.UTC().Format(time.RFC3339Nano),
		DisplayName:   u.DisplayName,
		HasAvatar:     u.AvatarAttachmentID > 0,
		AvatarVersion: u.AvatarAttachmentID,
	}
}

func usersToInfos(us []auth.User) []proto.UserInfo {
	out := make([]proto.UserInfo, len(us))
	for i, u := range us {
		out[i] = userToInfo(u)
	}
	return out
}

// presenceToInfos maps a hub OnlineUsers snapshot to the proto
// PresenceInfo[] used inside WelcomeMessage.online.
func presenceToInfos(ps []UserPresence) []proto.PresenceInfo {
	out := make([]proto.PresenceInfo, len(ps))
	for i, p := range ps {
		out[i] = proto.PresenceInfo{
			User:       userToInfo(p.User),
			State:      p.State,
			CustomText: p.CustomText,
		}
	}
	return out
}

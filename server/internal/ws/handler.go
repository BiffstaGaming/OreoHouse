package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

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
	hub      *Hub
	auth     *auth.Service
	convs    *conversations.Service
	messages *messages.Service
}

// NewHandler wires the Hub and the auth/conversations/messages
// services into an http.Handler.
func NewHandler(
	hub *Hub,
	authSvc *auth.Service,
	convsSvc *conversations.Service,
	msgsSvc *messages.Service,
) *Handler {
	return &Handler{hub: hub, auth: authSvc, convs: convsSvc, messages: msgsSvc}
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
			h.broadcastPresence(user, proto.StatusOffline)
			// Best-effort last_seen update. Use a fresh background
			// context — the request context may already be cancelled.
			bg, bgCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer bgCancel()
			if err := h.auth.UpdateLastSeen(bg, user.ID, time.Now().UTC()); err != nil {
				slog.Warn("ws: update last_seen failed", "error", err, "user_id", user.ID)
			}
		}
	}()

	// Welcome is sent inline (no writer goroutine yet) — it's safe
	// because we're the only writer on this connection at this point.
	if err := h.sendWelcome(ctx, conn, user); err != nil {
		slog.Info("ws: welcome write failed", "error", err, "user_id", user.ID)
		return
	}

	if firstConn {
		h.broadcastPresence(user, proto.StatusOnline)
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
	msg := proto.WelcomeMessage{
		Type:   proto.TypeWelcome,
		You:    userToInfo(user),
		Online: usersToInfos(h.hub.OnlineUsers()),
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

func (h *Handler) broadcastPresence(user auth.User, status string) {
	msg := proto.PresenceMessage{
		Type:   proto.TypePresence,
		User:   userToInfo(user),
		Status: status,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		slog.Error("ws: marshal presence failed", "error", err)
		return
	}
	h.hub.Broadcast(b)
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
		default:
			// Unknown / reserved types are silently ignored for
			// forward-compatibility. See docs/protocol.md.
		}
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

	persisted, err := h.messages.Send(ctx, in.ConversationID, c.user.ID, in.Body)
	if err != nil {
		slog.Error("ws: message persist failed", "error", err)
		h.sendErrorAsync(c, proto.ErrCodeForbidden, "internal error")
		return
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
		Sender: proto.UserInfo{
			ID:       c.user.ID,
			Username: c.user.Username,
		},
		Body:      persisted.Body,
		CreatedAt: persisted.CreatedAt.UTC().Format(time.RFC3339Nano),
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
		maxID := lastID
		for _, m := range missed {
			out := proto.OutgoingMessage{
				Type:           proto.TypeMessage,
				ID:             m.ID,
				ConversationID: m.ConversationID,
				Sender:         senderUserInfo(m.SenderID, members),
				Body:           m.Body,
				CreatedAt:      m.CreatedAt.UTC().Format(time.RFC3339Nano),
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
		ID:        u.ID,
		Username:  u.Username,
		CreatedAt: u.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func usersToInfos(us []auth.User) []proto.UserInfo {
	out := make([]proto.UserInfo, len(us))
	for i, u := range us {
		out[i] = userToInfo(u)
	}
	return out
}

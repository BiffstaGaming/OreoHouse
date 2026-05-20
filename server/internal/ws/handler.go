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
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// shutdownDrain is how long we wait for queued outbound messages to
// flush after the connection ends before forcing the writer to exit.
const shutdownDrain = 2 * time.Second

// Handler is the http.Handler for /ws. It authenticates via the
// ?token= query parameter, upgrades the connection, and runs the
// per-connection lifecycle (welcome → broadcast → read/write pumps →
// presence offline + last_seen_at update on disconnect).
type Handler struct {
	hub  *Hub
	auth *auth.Service
}

// NewHandler wires the Hub and auth.Service into an http.Handler.
func NewHandler(hub *Hub, authSvc *auth.Service) *Handler {
	return &Handler{hub: hub, auth: authSvc}
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
		default:
			// Unknown / reserved types are silently ignored for
			// forward-compatibility. See docs/protocol.md.
		}
	}
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

// Package ws is the OreoHouse WebSocket hub: an in-memory registry of
// active connections and a goroutine-safe broadcast channel.
//
// All reads and writes to the hub's internal state happen on the
// Run() goroutine. Public methods (Register, Unregister, Broadcast,
// OnlineUsers) communicate with that goroutine via channels, so the
// hub is safe for concurrent use by the HTTP request goroutines and
// per-connection read/write pumps.
package ws

import (
	"context"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
)

// Client is one active WS connection registered with the hub.
//
// Construct via newClient — exported only so handler.go can create
// instances; tests can do the same.
type Client struct {
	user auth.User
	send chan []byte
}

// User returns the authenticated user for this connection.
func (c *Client) User() auth.User { return c.user }

func newClient(user auth.User, sendBuffer int) *Client {
	if sendBuffer <= 0 {
		sendBuffer = 16
	}
	return &Client{
		user: user,
		send: make(chan []byte, sendBuffer),
	}
}

// Hub is the in-memory connection registry.
// UserPresence is the hub's per-user soft state tracked alongside
// connection registration: discrete state (online/away/busy) and the
// custom status text. Returned by OnlineUsers so callers can build
// rich presence snapshots without a second lookup.
type UserPresence struct {
	User       auth.User
	State      string
	CustomText string
}

type Hub struct {
	register   chan registerReq
	unregister chan unregisterReq
	broadcast  chan broadcastReq
	sendTo     chan sendToReq
	snapshot   chan snapshotReq
	setState   chan setStateReq

	// state — only touched from the Run() goroutine
	clients  map[*Client]struct{}
	perUser  map[int64]map[*Client]struct{}
	presence map[int64]presenceState
}

type presenceState struct {
	state      string
	customText string
}

type setStateReq struct {
	userID     int64
	state      string
	customText string
	resp       chan bool // true if state actually changed
}

type registerReq struct {
	client *Client
	resp   chan bool // true if this is the user's first active connection
}

type unregisterReq struct {
	client *Client
	resp   chan bool // true if this was the user's last active connection
}

type broadcastReq struct {
	msg []byte
}

type sendToReq struct {
	msg     []byte
	userIDs []int64
	resp    chan []int64
}

type snapshotReq struct {
	resp chan []UserPresence
}

// NewHub returns a fresh, unstarted Hub. Call Run to start its event
// loop.
func NewHub() *Hub {
	return &Hub{
		register:   make(chan registerReq),
		unregister: make(chan unregisterReq),
		broadcast:  make(chan broadcastReq, 64),
		sendTo:     make(chan sendToReq, 64),
		snapshot:   make(chan snapshotReq),
		setState:   make(chan setStateReq),
		clients:    make(map[*Client]struct{}),
		perUser:    make(map[int64]map[*Client]struct{}),
		presence:   make(map[int64]presenceState),
	}
}

// Run runs the hub's event loop. It returns when ctx is cancelled.
// Start it in its own goroutine before accepting connections.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case req := <-h.register:
			h.clients[req.client] = struct{}{}
			set, ok := h.perUser[req.client.user.ID]
			if !ok {
				set = make(map[*Client]struct{})
				h.perUser[req.client.user.ID] = set
				// Seed default presence on first connection so
				// snapshots always carry a state. The handler
				// follows up with SetPresence to fill in
				// custom_text from the DB.
				h.presence[req.client.user.ID] = presenceState{
					state: "online",
				}
			}
			set[req.client] = struct{}{}
			req.resp <- len(set) == 1
		case req := <-h.unregister:
			h.unregisterClient(req.client)
			set := h.perUser[req.client.user.ID]
			req.resp <- len(set) == 0 && !h.userHasAnyConn(req.client.user.ID)
		case req := <-h.broadcast:
			for c := range h.clients {
				select {
				case c.send <- req.msg:
				default:
					// Client's send buffer is full — drop the message
					// for that client. The reader/writer pumps will
					// detect the dead connection on their own. We do
					// NOT block the hub.
				}
			}
		case req := <-h.sendTo:
			delivered := make([]int64, 0, len(req.userIDs))
			for _, uid := range req.userIDs {
				set, ok := h.perUser[uid]
				if !ok || len(set) == 0 {
					continue
				}
				sentOne := false
				for c := range set {
					select {
					case c.send <- req.msg:
						sentOne = true
					default:
					}
				}
				if sentOne {
					delivered = append(delivered, uid)
				}
			}
			req.resp <- delivered
		case req := <-h.snapshot:
			out := make([]UserPresence, 0, len(h.perUser))
			for uid, set := range h.perUser {
				for c := range set {
					p := h.presence[uid]
					out = append(out, UserPresence{
						User:       c.user,
						State:      p.state,
						CustomText: p.customText,
					})
					break // one entry per user
				}
			}
			req.resp <- out
		case req := <-h.setState:
			if _, online := h.perUser[req.userID]; !online {
				// User has no active connections — refuse to
				// invent a phantom presence entry.
				req.resp <- false
				continue
			}
			cur := h.presence[req.userID]
			changed := cur.state != req.state || cur.customText != req.customText
			h.presence[req.userID] = presenceState{
				state:      req.state,
				customText: req.customText,
			}
			req.resp <- changed
		}
	}
}

// userHasAnyConn returns whether the per-user entry for id is still
// present (i.e. at least one connection survives). Called immediately
// after a delete to disambiguate "set is empty and gone" from "set
// still has entries".
func (h *Hub) userHasAnyConn(id int64) bool {
	_, ok := h.perUser[id]
	return ok
}

func (h *Hub) unregisterClient(c *Client) {
	if _, ok := h.clients[c]; !ok {
		return
	}
	delete(h.clients, c)
	close(c.send)
	set := h.perUser[c.user.ID]
	delete(set, c)
	if len(set) == 0 {
		delete(h.perUser, c.user.ID)
		delete(h.presence, c.user.ID)
	}
}

// Register adds c to the hub. Returns true if this is the user's
// first active connection (a presence "online" edge).
//
// Register does NOT initialise the user's discrete state; callers
// should follow up with SetPresence to seed it (the state is loaded
// from the DB so the hub layer stays unaware of the auth service).
func (h *Hub) Register(c *Client) bool {
	resp := make(chan bool, 1)
	h.register <- registerReq{client: c, resp: resp}
	return <-resp
}

// Unregister removes c from the hub. Returns true if this was the
// user's last active connection (a presence "offline" edge).
func (h *Hub) Unregister(c *Client) bool {
	resp := make(chan bool, 1)
	h.unregister <- unregisterReq{client: c, resp: resp}
	return <-resp
}

// Broadcast queues msg to every connected client's send buffer. If a
// client's buffer is full the message is dropped for that client only
// — broadcast never blocks the hub.
func (h *Hub) Broadcast(msg []byte) {
	h.broadcast <- broadcastReq{msg: msg}
}

// SendToUsers queues msg to every connection owned by any of the
// given user IDs. Returns the subset of userIDs that had at least one
// receiving connection — callers use this to advance per-user
// "last_delivered_message_id" cursors for online recipients. Users
// without active connections are silently skipped (their replay path
// will pick the message up when they reconnect).
func (h *Hub) SendToUsers(msg []byte, userIDs []int64) []int64 {
	if len(userIDs) == 0 {
		return nil
	}
	resp := make(chan []int64, 1)
	h.sendTo <- sendToReq{msg: msg, userIDs: userIDs, resp: resp}
	return <-resp
}

// OnlineUsers returns one UserPresence per currently online user, in
// undefined order. Safe to call concurrently.
func (h *Hub) OnlineUsers() []UserPresence {
	resp := make(chan []UserPresence, 1)
	h.snapshot <- snapshotReq{resp: resp}
	return <-resp
}

// SetPresence initialises or updates a user's discrete state +
// custom text. Returns true when the new value actually changed
// (callers use this to skip redundant broadcasts). A call for a
// user with no active connections is a silent no-op.
func (h *Hub) SetPresence(userID int64, state, customText string) bool {
	resp := make(chan bool, 1)
	h.setState <- setStateReq{
		userID:     userID,
		state:      state,
		customText: customText,
		resp:       resp,
	}
	return <-resp
}

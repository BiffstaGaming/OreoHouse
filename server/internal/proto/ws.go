package proto

// Wire protocol type discriminators. See docs/protocol.md for the
// canonical catalog and semantics.
const (
	TypeWelcome                    = "welcome"
	TypePresence                   = "presence"
	TypeError                      = "error"
	TypePing                       = "ping"
	TypePong                       = "pong"
	TypeMessage                    = "message"
	TypeConversationAdded          = "conversation_added"
	TypeConversationMembersChanged = "conversation_members_changed"
	TypeStatus                     = "status"
	TypeTyping                     = "typing"
	TypeNudge                      = "nudge"
)

// Presence state values for PresenceMessage.State and
// PresenceInfo.State. "offline" only appears in PresenceMessage
// deltas — it never shows up in the welcome snapshot.
const (
	StateOnline  = "online"
	StateAway    = "away"
	StateBusy    = "busy"
	StateOffline = "offline"
)

// ValidUserState reports whether s is a state value the server will
// accept from a client `status` event. "offline" is reserved for the
// server to emit when a user's last connection closes.
func ValidUserState(s string) bool {
	switch s {
	case StateOnline, StateAway, StateBusy:
		return true
	}
	return false
}

// Stable error codes used in ErrorMessage.Code. Clients can branch on
// these without parsing the human-readable Message.
const (
	ErrCodeInvalidMessage = "invalid_message"
	ErrCodeUnknownType    = "unknown_type"
	ErrCodeForbidden      = "forbidden"
)

// Envelope reads the type discriminator off any incoming message
// before decoding into a concrete shape.
type Envelope struct {
	Type string `json:"type"`
}

// PresenceInfo is the snapshot shape used inside WelcomeMessage.online
// — one row per currently-online user, carrying their User plus the
// discrete state (online/away/busy) and optional custom message.
type PresenceInfo struct {
	User       UserInfo `json:"user"`
	State      string   `json:"state"`
	CustomText string   `json:"custom_text,omitempty"`
}

// WelcomeMessage is sent server→client immediately after a successful
// /ws upgrade. It snapshots current presence so the client can build
// its initial UI without polling.
type WelcomeMessage struct {
	Type   string         `json:"type"`
	You    UserInfo       `json:"you"`
	Online []PresenceInfo `json:"online"`
}

// PresenceMessage is broadcast to every online client whenever a
// user's presence changes — they came online, went offline, or
// changed their state / custom message while online.
//
// State is one of StateOnline / StateAway / StateBusy / StateOffline.
// CustomText is empty when not set; it is also not meaningful when
// State == StateOffline (the client should drop the user from its
// online map in that case).
type PresenceMessage struct {
	Type       string   `json:"type"`
	User       UserInfo `json:"user"`
	State      string   `json:"state"`
	CustomText string   `json:"custom_text,omitempty"`
}

// StatusMessage is the client→server "status" envelope — set my
// state and/or custom message. The server validates State (online/
// away/busy only — "offline" is reserved) and broadcasts a
// PresenceMessage to all online clients.
type StatusMessage struct {
	Type       string `json:"type"`
	State      string `json:"state"`
	CustomText string `json:"custom_text"`
}

// IncomingTypingMessage is client→server: I'm typing in this
// conversation. The server fans out a TypingMessage to every other
// member. Clients should throttle these (~one every 2 seconds while
// actively typing).
type IncomingTypingMessage struct {
	Type           string `json:"type"`
	ConversationID int64  `json:"conversation_id"`
}

// TypingMessage is server→other-members for a typing event. Clients
// treat each one as "this user is typing for the next ~5 s"; the
// indicator expires on a timer rather than via an explicit
// stop-typing event.
type TypingMessage struct {
	Type           string   `json:"type"`
	ConversationID int64    `json:"conversation_id"`
	User           UserInfo `json:"user"`
}

// IncomingNudgeMessage is client→server: shake everyone else in
// this conversation. Servers should rate-limit per-conversation if
// abuse appears; for Phase 7 we trust the client-side cooldown.
type IncomingNudgeMessage struct {
	Type           string `json:"type"`
	ConversationID int64  `json:"conversation_id"`
}

// NudgeMessage is server→other-members for a nudge event. Recipients
// shake the corresponding chat window (opening or restoring it if
// minimized) and play the nudge sound.
type NudgeMessage struct {
	Type           string   `json:"type"`
	ConversationID int64    `json:"conversation_id"`
	Sender         UserInfo `json:"sender"`
}

// ErrorMessage is sent server→client immediately before a connection
// close caused by a protocol violation. /ws auth failures are HTTP
// 401s before the upgrade and do not produce an ErrorMessage.
type ErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PingMessage is the client's keepalive. The server replies PongMessage.
type PingMessage struct {
	Type string `json:"type"`
}

// PongMessage is the server's reply to PingMessage.
type PongMessage struct {
	Type string `json:"type"`
}

// IncomingMessage is the client→server "message" envelope: send a
// chat message to a conversation the sender is a member of. At least
// one of Body or AttachmentIDs must be present.
type IncomingMessage struct {
	Type           string  `json:"type"`
	ConversationID int64   `json:"conversation_id"`
	Body           string  `json:"body"`
	AttachmentIDs  []int64 `json:"attachment_ids,omitempty"`
}

// OutgoingMessage is the server→every-member "message" envelope.
// Echoed to the sender too so a single message path drives all UIs.
type OutgoingMessage struct {
	Type           string           `json:"type"`
	ID             int64            `json:"id"`
	ConversationID int64            `json:"conversation_id"`
	Sender         UserInfo         `json:"sender"`
	Body           string           `json:"body"`
	CreatedAt      string           `json:"created_at"`
	Attachments    []AttachmentView `json:"attachments,omitempty"`
}

// ConversationAddedMessage is pushed to a user when they're added to
// a new conversation (group create / group invite / room join). Carries
// the full ConversationView so the client can put it in its list
// without an extra round-trip.
type ConversationAddedMessage struct {
	Type         string           `json:"type"`
	Conversation ConversationView `json:"conversation"`
}

// ConversationMembersChangedMessage is pushed to existing members of a
// conversation when its membership changes (someone added, someone
// left). Carries the new full member list — clients replace rather
// than diff.
type ConversationMembersChangedMessage struct {
	Type           string     `json:"type"`
	ConversationID int64      `json:"conversation_id"`
	Members        []UserInfo `json:"members"`
}

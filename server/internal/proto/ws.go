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
	TypeRead                       = "read"
	TypeReadReceipt                = "read_receipt"
	TypeUserProfileChanged         = "user_profile_changed"
	TypeReact                      = "react"
	TypeReaction                   = "reaction"
	TypeEdit                       = "edit"
	TypeMessageEdited              = "message_edited"
	TypeDelete                     = "delete"
	TypeMessageDeleted             = "message_deleted"
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

// ReadStateView is one row of conversation_read_states, surfaced to
// clients in welcome.reads and (live) via ReadReceiptMessage so the UI
// can render tick marks.
type ReadStateView struct {
	ConversationID    int64  `json:"conversation_id"`
	UserID            int64  `json:"user_id"`
	LastReadMessageID int64  `json:"last_read_message_id"`
	At                string `json:"at"`
}

// WelcomeMessage is sent server→client immediately after a successful
// /ws upgrade. It snapshots current presence (and read-receipt state
// for the user's convs) so the client can build its initial UI
// without polling.
type WelcomeMessage struct {
	Type   string          `json:"type"`
	You    UserInfo        `json:"you"`
	Online []PresenceInfo  `json:"online"`
	Reads  []ReadStateView `json:"reads"`
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
// one of Body or AttachmentIDs must be present. ReplyToID, when
// non-zero, references another message id in the same conversation
// the client is quoting.
type IncomingMessage struct {
	Type           string  `json:"type"`
	ConversationID int64   `json:"conversation_id"`
	Body           string  `json:"body"`
	AttachmentIDs  []int64 `json:"attachment_ids,omitempty"`
	ReplyToID      int64   `json:"reply_to_id,omitempty"`
}

// IncomingEditMessage is the client→server "edit" envelope. Server
// validates sender + 15-minute window + body length, then broadcasts
// MessageEditedMessage to every conversation member.
type IncomingEditMessage struct {
	Type      string `json:"type"`
	MessageID int64  `json:"message_id"`
	Body      string `json:"body"`
}

// MessageEditedMessage is server→all-members for a successful edit.
type MessageEditedMessage struct {
	Type           string `json:"type"`
	MessageID      int64  `json:"message_id"`
	ConversationID int64  `json:"conversation_id"`
	Body           string `json:"body"`
	EditedAt       string `json:"edited_at"`
}

// IncomingDeleteMessage is the client→server "delete" envelope.
// Server validates sender, then soft-deletes and broadcasts
// MessageDeletedMessage.
type IncomingDeleteMessage struct {
	Type      string `json:"type"`
	MessageID int64  `json:"message_id"`
}

// MessageDeletedMessage is server→all-members for a soft-delete.
type MessageDeletedMessage struct {
	Type           string `json:"type"`
	MessageID      int64  `json:"message_id"`
	ConversationID int64  `json:"conversation_id"`
	DeletedAt      string `json:"deleted_at"`
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
	EditedAt       string           `json:"edited_at,omitempty"`
	DeletedAt      string           `json:"deleted_at,omitempty"`
	Attachments    []AttachmentView `json:"attachments,omitempty"`
	Reactions      []ReactionGroup  `json:"reactions,omitempty"`
	ReplyTo        *ReplySnippet    `json:"reply_to,omitempty"`
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

// IncomingReadMessage is the client→server "read" envelope: the user
// has seen messages up to LastReadMessageID in this conversation.
// The server validates membership, persists monotonically, and (if
// the cursor advanced) broadcasts a ReadReceiptMessage to other
// members.
type IncomingReadMessage struct {
	Type              string `json:"type"`
	ConversationID    int64  `json:"conversation_id"`
	LastReadMessageID int64  `json:"last_read_message_id"`
}

// ReadReceiptMessage is server→other-members when a read cursor
// advances. The recipient should update its per-(conv, user) read map
// to reflect the new high-water mark and re-render tick indicators
// on the sender's messages.
type ReadReceiptMessage struct {
	Type              string   `json:"type"`
	ConversationID    int64    `json:"conversation_id"`
	User              UserInfo `json:"user"`
	LastReadMessageID int64    `json:"last_read_message_id"`
	At                string   `json:"at"`
}

// UserProfileChangedMessage is broadcast to every connected client
// whenever a user updates their display_name or avatar. Carries the
// freshly-loaded UserInfo so clients can swap their cached copy in
// one operation.
type UserProfileChangedMessage struct {
	Type string   `json:"type"`
	User UserInfo `json:"user"`
}

// IncomingReactMessage is the client→server "react" envelope. The
// server toggles the (message, user, emoji) row and broadcasts a
// ReactionMessage with action: "add" | "remove" to every member of
// the message's conversation.
type IncomingReactMessage struct {
	Type      string `json:"type"`
	MessageID int64  `json:"message_id"`
	Emoji     string `json:"emoji"`
}

// ReactionMessage is server→all-members for a reaction toggle. Action
// is "add" or "remove" so clients can update their per-message
// reaction map without re-fetching.
type ReactionMessage struct {
	Type           string   `json:"type"`
	MessageID      int64    `json:"message_id"`
	ConversationID int64    `json:"conversation_id"`
	User           UserInfo `json:"user"`
	Emoji          string   `json:"emoji"`
	Action         string   `json:"action"` // "add" | "remove"
}

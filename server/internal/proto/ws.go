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
)

// Presence status values for PresenceMessage.Status.
const (
	StatusOnline  = "online"
	StatusOffline = "offline"
)

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

// WelcomeMessage is sent server→client immediately after a successful
// /ws upgrade. It snapshots current presence so the client can build
// its initial UI without polling.
type WelcomeMessage struct {
	Type   string     `json:"type"`
	You    UserInfo   `json:"you"`
	Online []UserInfo `json:"online"`
}

// PresenceMessage is broadcast to every online client when a user's
// presence flips. A user is "online" if they have ≥1 active WS
// connection.
type PresenceMessage struct {
	Type   string   `json:"type"`
	User   UserInfo `json:"user"`
	Status string   `json:"status"` // StatusOnline or StatusOffline
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

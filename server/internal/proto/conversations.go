package proto

// ConversationView is the JSON projection of a conversation used by
// the REST API. Members are always populated (joined with users).
type ConversationView struct {
	ID        int64      `json:"id"`
	Type      string     `json:"type"`
	Name      string     `json:"name,omitempty"`
	Topic     string     `json:"topic,omitempty"`
	CreatedAt string     `json:"created_at"`
	Members   []UserInfo `json:"members"`
}

// CreateGroupRequest is the body of POST /api/conversations/group.
// Name is optional. member_ids is the initial set (creator is always
// added even if absent / duplicated).
type CreateGroupRequest struct {
	Name      string  `json:"name,omitempty"`
	MemberIDs []int64 `json:"member_ids"`
}

// CreateRoomRequest is the body of POST /api/conversations/room.
// Name is required; topic is optional.
type CreateRoomRequest struct {
	Name  string `json:"name"`
	Topic string `json:"topic,omitempty"`
}

// AddMembersRequest is the body of POST /api/conversations/{id}/members.
type AddMembersRequest struct {
	UserIDs []int64 `json:"user_ids"`
}

// UpdateConversationRequest is the body of PUT /api/conversations/{id}.
// Pointer fields let the caller patch one column at a time —
// `name: null` is "leave unchanged", `name: ""` is "clear the value".
// DMs are rejected (no name/topic on DMs).
type UpdateConversationRequest struct {
	Name  *string `json:"name,omitempty"`
	Topic *string `json:"topic,omitempty"`
}

// RoomView is the JSON projection used by GET /api/rooms — name,
// topic, and a denormalised member count for the discovery list.
// Full member lists go through ConversationView once a user joins.
type RoomView struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Topic       string `json:"topic,omitempty"`
	CreatedAt   string `json:"created_at"`
	MemberCount int    `json:"member_count"`
}

// ListRoomsResponse is the body of GET /api/rooms.
type ListRoomsResponse struct {
	Rooms []RoomView `json:"rooms"`
}

// AttachmentView is the JSON projection of an attachment row, used
// both in upload responses and as the nested attachment list on
// MessageView / OutgoingMessage.
type AttachmentView struct {
	ID          int64  `json:"id"`
	Filename    string `json:"filename"`
	MimeType    string `json:"mime_type"`
	SizeBytes   int64  `json:"size_bytes"`
	ImageWidth  int    `json:"image_width,omitempty"`
	ImageHeight int    `json:"image_height,omitempty"`
}

// ListConversationsResponse is the body of GET /api/conversations.
type ListConversationsResponse struct {
	Conversations []ConversationView `json:"conversations"`
}

// CreateDMRequest is the body of POST /api/conversations/dm.
type CreateDMRequest struct {
	UserID int64 `json:"user_id"`
}

// ReactionGroup folds every (user, emoji) pair on a single message
// into one entry per emoji, with the list of user_ids who reacted.
// Used by MessageView + OutgoingMessage so the client can render
// pills without re-grouping.
type ReactionGroup struct {
	Emoji   string  `json:"emoji"`
	UserIDs []int64 `json:"user_ids"`
}

// ReplySnippet is a tiny preview of a quoted message, embedded under
// MessageView.ReplyTo so the client can render the quote header
// without a second fetch. Body is truncated by the server.
type ReplySnippet struct {
	ID       int64    `json:"id"`
	Sender   UserInfo `json:"sender"`
	Body     string   `json:"body"`
	Deleted  bool     `json:"deleted,omitempty"`
}

// MessageView is the JSON projection of a message.
type MessageView struct {
	ID             int64            `json:"id"`
	ConversationID int64            `json:"conversation_id"`
	Sender         UserInfo         `json:"sender"`
	Body           string           `json:"body"`
	CreatedAt      string           `json:"created_at"`
	EditedAt       string           `json:"edited_at,omitempty"`
	DeletedAt      string           `json:"deleted_at,omitempty"`
	Attachments    []AttachmentView `json:"attachments,omitempty"`
	Reactions      []ReactionGroup  `json:"reactions,omitempty"`
	// ReplyTo is non-nil iff this message is a quote of another.
	ReplyTo *ReplySnippet `json:"reply_to,omitempty"`
}

// ListMessagesResponse is the body of GET /api/conversations/{id}/messages.
// Messages are returned newest first so the smallest id in the slice
// is the cursor for the next "before=" call.
type ListMessagesResponse struct {
	Messages []MessageView `json:"messages"`
}

// SearchResponse is the body of GET /api/search.
type SearchResponse struct {
	Results []MessageView `json:"results"`
}

// PinView is one pinned message — the full MessageView plus the pin
// timestamp and the user who pinned it.
type PinView struct {
	Message  MessageView `json:"message"`
	PinnedBy UserInfo    `json:"pinned_by"`
	PinnedAt string      `json:"pinned_at"`
}

// ListPinsResponse is the body of GET /api/conversations/{id}/pins.
type ListPinsResponse struct {
	Pins []PinView `json:"pins"`
}

// MediaItem is one entry in the per-conversation media gallery.
// Currently every attachment in the conv (image or otherwise); the
// client may filter to images-only when rendering the "Photos" tab.
type MediaItem struct {
	Attachment AttachmentView `json:"attachment"`
	MessageID  int64          `json:"message_id"`
	Sender     UserInfo       `json:"sender"`
	CreatedAt  string         `json:"created_at"`
}

// ListMediaResponse is the body of GET /api/conversations/{id}/media.
// Items are newest-first; the smallest id is the cursor for the next
// page if pagination is added later.
type ListMediaResponse struct {
	Items []MediaItem `json:"items"`
}

// LinkItem is one URL that appeared in a message body in the
// conversation, with enough context to render + jump to source.
type LinkItem struct {
	URL            string   `json:"url"`
	MessageID      int64    `json:"message_id"`
	ConversationID int64    `json:"conversation_id"`
	Sender         UserInfo `json:"sender"`
	CreatedAt      string   `json:"created_at"`
}

// ListLinksResponse is the body of GET /api/conversations/{id}/links.
type ListLinksResponse struct {
	Items []LinkItem `json:"items"`
}

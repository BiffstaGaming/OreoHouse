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

// MessageView is the JSON projection of a message.
type MessageView struct {
	ID             int64            `json:"id"`
	ConversationID int64            `json:"conversation_id"`
	Sender         UserInfo         `json:"sender"`
	Body           string           `json:"body"`
	CreatedAt      string           `json:"created_at"`
	Attachments    []AttachmentView `json:"attachments,omitempty"`
	Reactions      []ReactionGroup  `json:"reactions,omitempty"`
}

// ListMessagesResponse is the body of GET /api/conversations/{id}/messages.
// Messages are returned newest first so the smallest id in the slice
// is the cursor for the next "before=" call.
type ListMessagesResponse struct {
	Messages []MessageView `json:"messages"`
}

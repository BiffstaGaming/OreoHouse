package proto

// ConversationView is the JSON projection of a conversation used by
// the REST API. Members are always populated (joined with users).
type ConversationView struct {
	ID        int64      `json:"id"`
	Type      string     `json:"type"`
	Name      string     `json:"name,omitempty"`
	CreatedAt string     `json:"created_at"`
	Members   []UserInfo `json:"members"`
}

// ListConversationsResponse is the body of GET /api/conversations.
type ListConversationsResponse struct {
	Conversations []ConversationView `json:"conversations"`
}

// CreateDMRequest is the body of POST /api/conversations/dm.
type CreateDMRequest struct {
	UserID int64 `json:"user_id"`
}

// MessageView is the JSON projection of a message.
type MessageView struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	Sender         UserInfo `json:"sender"`
	Body           string `json:"body"`
	CreatedAt      string `json:"created_at"`
}

// ListMessagesResponse is the body of GET /api/conversations/{id}/messages.
// Messages are returned newest first so the smallest id in the slice
// is the cursor for the next "before=" call.
type ListMessagesResponse struct {
	Messages []MessageView `json:"messages"`
}

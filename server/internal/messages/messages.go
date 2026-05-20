// Package messages persists and retrieves messages from the messages
// table (created by migration 0003).
//
// Send writes a new row. HistoryPage walks messages backwards through
// a conversation by cursor for displaying the chat scrollback. Since
// walks forward from a delivery cursor for the WS replay on reconnect.
package messages

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// MaxBodyBytes caps the message body size. Family chat doesn't need
// long-form content; bigger payloads are an abuse/storage concern.
const MaxBodyBytes = 4096

// DefaultHistoryLimit is the page size used when the caller passes
// limit<=0.
const DefaultHistoryLimit = 50

// MaxHistoryLimit caps the page size to keep query latency predictable.
const MaxHistoryLimit = 200

// DefaultReplayLimit caps a single Since() reply when limit<=0.
// Enough that a multi-week absence still replays in one go for our
// scale, but not unbounded.
const DefaultReplayLimit = 500

var (
	ErrBodyEmpty   = errors.New("message body is empty")
	ErrBodyTooLong = fmt.Errorf("message body exceeds %d bytes", MaxBodyBytes)
)

// Message is a row in the messages table.
type Message struct {
	ID             int64
	ConversationID int64
	SenderID       int64
	Body           string
	CreatedAt      time.Time
}

// Service is the messages-related database accessor.
type Service struct {
	db  *sql.DB
	now func() time.Time
}

// NewService returns a Service that reads and writes via db.
func NewService(db *sql.DB) *Service {
	return &Service{
		db:  db,
		now: func() time.Time { return time.Now().UTC() },
	}
}

// ValidateBody returns ErrBodyEmpty / ErrBodyTooLong if body is not
// allowed. Caller (CLI, REST, WS handler) should validate before
// hitting Send.
func ValidateBody(body string) error {
	if len(body) == 0 {
		return ErrBodyEmpty
	}
	if len(body) > MaxBodyBytes {
		return ErrBodyTooLong
	}
	return nil
}

// Send inserts a new message. The caller is responsible for verifying
// the sender is a member of the conversation — Send does not check
// (and shouldn't, to keep this layer simple).
func (s *Service) Send(ctx context.Context, conversationID, senderID int64, body string) (Message, error) {
	if err := ValidateBody(body); err != nil {
		return Message{}, err
	}
	now := s.now()
	res, err := s.db.ExecContext(ctx,
		"INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)",
		conversationID, senderID, body, formatTime(now))
	if err != nil {
		return Message{}, fmt.Errorf("inserting message: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Message{}, fmt.Errorf("last insert id: %w", err)
	}
	return Message{
		ID:             id,
		ConversationID: conversationID,
		SenderID:       senderID,
		Body:           body,
		CreatedAt:      now,
	}, nil
}

// HistoryPage returns at most `limit` messages in conversationID with
// id < beforeID, newest first. Pass beforeID=0 for the most recent
// page. limit is clamped to [1, MaxHistoryLimit] (defaulting to
// DefaultHistoryLimit on <=0).
//
// Returning newest-first matches the cursor-pagination convention
// (the client uses the smallest id in the page as the next cursor)
// and lets the UI render top-down without an extra reversal.
func (s *Service) HistoryPage(ctx context.Context, conversationID, beforeID int64, limit int) ([]Message, error) {
	limit = clampHistoryLimit(limit)

	var (
		rows *sql.Rows
		err  error
	)
	if beforeID > 0 {
		rows, err = s.db.QueryContext(ctx, `
            SELECT id, conversation_id, sender_id, body, created_at
              FROM messages
             WHERE conversation_id = ? AND id < ?
          ORDER BY id DESC
             LIMIT ?
        `, conversationID, beforeID, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
            SELECT id, conversation_id, sender_id, body, created_at
              FROM messages
             WHERE conversation_id = ?
          ORDER BY id DESC
             LIMIT ?
        `, conversationID, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("querying history: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// Since returns at most `limit` messages in conversationID with id >
// sinceID, oldest first. Used by the WS handler to replay messages
// that arrived while the user was offline. limit defaults to
// DefaultReplayLimit when <=0.
func (s *Service) Since(ctx context.Context, conversationID, sinceID int64, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = DefaultReplayLimit
	}
	rows, err := s.db.QueryContext(ctx, `
        SELECT id, conversation_id, sender_id, body, created_at
          FROM messages
         WHERE conversation_id = ? AND id > ?
      ORDER BY id ASC
         LIMIT ?
    `, conversationID, sinceID, limit)
	if err != nil {
		return nil, fmt.Errorf("querying since: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

func scanMessages(rows *sql.Rows) ([]Message, error) {
	var out []Message
	for rows.Next() {
		var (
			m         Message
			createdAt string
		)
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Body, &createdAt); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		t, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse created_at: %w", err)
		}
		m.CreatedAt = t
		out = append(out, m)
	}
	return out, rows.Err()
}

func clampHistoryLimit(limit int) int {
	if limit <= 0 {
		return DefaultHistoryLimit
	}
	if limit > MaxHistoryLimit {
		return MaxHistoryLimit
	}
	return limit
}

func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func parseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing time %q: %w", s, err)
	}
	return t.UTC(), nil
}

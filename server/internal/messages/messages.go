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
	ErrBodyTooLong = fmt.Errorf("message body exceeds %d bytes", MaxBodyBytes)
	ErrNotFound    = errors.New("message not found")
)

// Message is a row in the messages table.
type Message struct {
	ID             int64
	ConversationID int64
	SenderID       int64
	Body           string
	CreatedAt      time.Time
	// EditedAt is the zero value when the message has never been edited.
	EditedAt time.Time
	// DeletedAt is the zero value while the message is live. When set,
	// callers serving the wire should suppress Body to "" — the row
	// stays in history so id sequences stay dense.
	DeletedAt time.Time
	// ReplyToID is the message id this message is replying to, or 0
	// when it isn't a reply.
	ReplyToID int64
}

// EditWindow is how long after creation a sender can still edit or
// delete their own message. Past this, the WS handler refuses with
// ErrEditWindowExpired so old messages stay immutable.
const EditWindow = 15 * time.Minute

// Sentinel errors specific to mutation.
var (
	ErrNotSender         = errors.New("message not owned by sender")
	ErrEditWindowExpired = errors.New("edit window has expired")
	ErrAlreadyDeleted    = errors.New("message is already deleted")
)

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

// ValidateBody returns ErrBodyTooLong if body exceeds MaxBodyBytes.
// Empty bodies are allowed at this layer — Phase 5 introduced
// attachment-only messages, and the body-XOR-attachments rule lives
// in the WS handler. Callers (WS / future REST) still need to enforce
// "must have body OR attachments" themselves.
func ValidateBody(body string) error {
	if len(body) > MaxBodyBytes {
		return ErrBodyTooLong
	}
	return nil
}

// Send inserts a new message. The caller is responsible for verifying
// the sender is a member of the conversation AND that body + any
// attachments together satisfy the "body OR attachments" rule — Send
// only enforces the body length cap. ReplyToID is 0 for non-replies.
func (s *Service) Send(ctx context.Context, conversationID, senderID int64, body string) (Message, error) {
	return s.SendReply(ctx, conversationID, senderID, body, 0)
}

// SendReply inserts a message that optionally quotes another by id.
// When replyToID > 0 the column is stored on the row and surfaced in
// later HistoryPage/Since reads. The caller is responsible for
// verifying the referenced message exists AND lives in the same conv.
func (s *Service) SendReply(
	ctx context.Context,
	conversationID, senderID int64,
	body string,
	replyToID int64,
) (Message, error) {
	if err := ValidateBody(body); err != nil {
		return Message{}, err
	}
	now := s.now()
	var replyArg any
	if replyToID > 0 {
		replyArg = replyToID
	}
	res, err := s.db.ExecContext(ctx, `
        INSERT INTO messages (conversation_id, sender_id, body, created_at, reply_to_id)
        VALUES (?, ?, ?, ?, ?)`,
		conversationID, senderID, body, formatTime(now), replyArg)
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
		ReplyToID:      replyToID,
	}, nil
}

// EditMessage replaces the body of messageID, recording edited_at.
// Returns ErrNotFound when no row matches, ErrNotSender if userID
// doesn't own it, ErrAlreadyDeleted if the row is tomb-stoned, and
// ErrEditWindowExpired past the EditWindow. The updated body still
// has to satisfy ValidateBody.
func (s *Service) EditMessage(
	ctx context.Context,
	messageID, userID int64,
	body string,
) (Message, error) {
	if err := ValidateBody(body); err != nil {
		return Message{}, err
	}
	m, err := s.Get(ctx, messageID)
	if err != nil {
		return Message{}, err
	}
	if m.SenderID != userID {
		return Message{}, ErrNotSender
	}
	if !m.DeletedAt.IsZero() {
		return Message{}, ErrAlreadyDeleted
	}
	if s.now().Sub(m.CreatedAt) > EditWindow {
		return Message{}, ErrEditWindowExpired
	}
	now := s.now()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE messages SET body = ?, edited_at = ? WHERE id = ?",
		body, formatTime(now), messageID); err != nil {
		return Message{}, fmt.Errorf("updating message: %w", err)
	}
	m.Body = body
	m.EditedAt = now
	return m, nil
}

// DeleteMessage soft-deletes a message — stamps deleted_at and clears
// body. Returns ErrNotSender if userID doesn't own it, ErrNotFound
// if absent. Idempotent: a second call is a no-op.
func (s *Service) DeleteMessage(
	ctx context.Context, messageID, userID int64,
) (Message, error) {
	m, err := s.Get(ctx, messageID)
	if err != nil {
		return Message{}, err
	}
	if m.SenderID != userID {
		return Message{}, ErrNotSender
	}
	if !m.DeletedAt.IsZero() {
		return m, nil
	}
	now := s.now()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE messages SET body = '', deleted_at = ? WHERE id = ?",
		formatTime(now), messageID); err != nil {
		return Message{}, fmt.Errorf("deleting message: %w", err)
	}
	m.Body = ""
	m.DeletedAt = now
	return m, nil
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
            SELECT id, conversation_id, sender_id, body, created_at,
                   edited_at, deleted_at, reply_to_id
              FROM messages
             WHERE conversation_id = ? AND id < ?
          ORDER BY id DESC
             LIMIT ?
        `, conversationID, beforeID, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
            SELECT id, conversation_id, sender_id, body, created_at,
                   edited_at, deleted_at, reply_to_id
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

// Get returns a single message by ID; ErrNotFound if absent.
func (s *Service) Get(ctx context.Context, id int64) (Message, error) {
	var (
		m         Message
		createdAt string
		editedAt  sql.NullString
		deletedAt sql.NullString
		replyTo   sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx, `
        SELECT id, conversation_id, sender_id, body, created_at,
               edited_at, deleted_at, reply_to_id
          FROM messages
         WHERE id = ?`, id,
	).Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Body, &createdAt,
		&editedAt, &deletedAt, &replyTo)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, fmt.Errorf("querying message: %w", err)
	}
	t, err := parseTime(createdAt)
	if err != nil {
		return Message{}, fmt.Errorf("parse created_at: %w", err)
	}
	m.CreatedAt = t
	if editedAt.Valid {
		m.EditedAt, _ = parseTime(editedAt.String)
	}
	if deletedAt.Valid {
		m.DeletedAt, _ = parseTime(deletedAt.String)
	}
	if replyTo.Valid {
		m.ReplyToID = replyTo.Int64
	}
	return m, nil
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
        SELECT id, conversation_id, sender_id, body, created_at,
               edited_at, deleted_at, reply_to_id
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

// MaxSearchLimit caps how many results a single Search call returns.
const MaxSearchLimit = 50

// Search runs a full-text search against the body of every message
// in conversations the userID is a member of. Results are newest-first
// (by id). If convID > 0 the search is restricted to that one conv.
//
// query is passed to FTS5 verbatim — clients can use phrases ("...")
// and column operators if they like.
func (s *Service) Search(
	ctx context.Context,
	userID int64,
	query string,
	convID int64,
	limit int,
) ([]Message, error) {
	if limit <= 0 || limit > MaxSearchLimit {
		limit = MaxSearchLimit
	}
	if query == "" {
		return nil, nil
	}
	// Membership-gated: JOIN onto conversation_members + filter by
	// user_id, so the user can't search messages from conversations
	// they're not in.
	var (
		rows *sql.Rows
		err  error
	)
	if convID > 0 {
		rows, err = s.db.QueryContext(ctx, `
            SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at,
                   m.edited_at, m.deleted_at, m.reply_to_id
              FROM messages_fts f
              JOIN messages m ON m.id = f.rowid
              JOIN conversation_members cm
                ON cm.conversation_id = m.conversation_id
             WHERE f.messages_fts MATCH ?
               AND cm.user_id = ?
               AND m.conversation_id = ?
               AND m.deleted_at IS NULL
          ORDER BY m.id DESC
             LIMIT ?
        `, query, userID, convID, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
            SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at,
                   m.edited_at, m.deleted_at, m.reply_to_id
              FROM messages_fts f
              JOIN messages m ON m.id = f.rowid
              JOIN conversation_members cm
                ON cm.conversation_id = m.conversation_id
             WHERE f.messages_fts MATCH ?
               AND cm.user_id = ?
               AND m.deleted_at IS NULL
          ORDER BY m.id DESC
             LIMIT ?
        `, query, userID, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("fts search: %w", err)
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
			editedAt  sql.NullString
			deletedAt sql.NullString
			replyTo   sql.NullInt64
		)
		if err := rows.Scan(
			&m.ID, &m.ConversationID, &m.SenderID, &m.Body, &createdAt,
			&editedAt, &deletedAt, &replyTo,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		t, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse created_at: %w", err)
		}
		m.CreatedAt = t
		if editedAt.Valid {
			m.EditedAt, _ = parseTime(editedAt.String)
		}
		if deletedAt.Valid {
			m.DeletedAt, _ = parseTime(deletedAt.String)
		}
		if replyTo.Valid {
			m.ReplyToID = replyTo.Int64
		}
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

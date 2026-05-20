// Package conversations manages the conversations, conversation_members,
// and (via dependencies) messages tables.
//
// A Conversation is a row with a type discriminator ("dm", "group", or
// "room"). DMs are auto-created by FindOrCreateDM the first time two
// users interact; groups and rooms (Phase 4) are created explicitly.
package conversations

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Conversation type discriminators. Mirrored by the CHECK constraint on
// conversations.type in migration 0003.
const (
	TypeDM    = "dm"
	TypeGroup = "group"
	TypeRoom  = "room"
)

// Sentinel errors returned by Service methods.
var (
	ErrNotFound  = errors.New("conversation not found")
	ErrNotMember = errors.New("user is not a member of this conversation")
	ErrSelfDM    = errors.New("cannot create a DM with yourself")
)

// Conversation is a row in the conversations table.
type Conversation struct {
	ID        int64
	Type      string
	Name      string // empty when NULL (DMs always; groups/rooms optionally)
	CreatedAt time.Time
}

// Member is a row in conversation_members, joined with the user's username
// for display convenience.
type Member struct {
	UserID                 int64
	Username               string
	JoinedAt               time.Time
	LastDeliveredMessageID int64 // 0 when NULL (no message has been delivered yet)
}

// Service is the conversations-related database accessor.
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

// FindOrCreateDM finds the unique DM conversation between userA and
// userB, creating one (and inserting both members) if none exists.
// Order of the user IDs doesn't matter — (a, b) and (b, a) resolve to
// the same Conversation. Returns ErrSelfDM if both IDs are equal.
func (s *Service) FindOrCreateDM(ctx context.Context, userA, userB int64) (Conversation, error) {
	if userA == userB {
		return Conversation{}, ErrSelfDM
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Conversation{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var convID int64
	err = tx.QueryRowContext(ctx, `
        SELECT c.id
          FROM conversations c
          JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
          JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
         WHERE c.type = 'dm'
    `, userA, userB).Scan(&convID)
	if err == nil {
		c, err := getConversationTx(ctx, tx, convID)
		if err != nil {
			return Conversation{}, err
		}
		if err := tx.Commit(); err != nil {
			return Conversation{}, fmt.Errorf("commit: %w", err)
		}
		return c, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, fmt.Errorf("looking up dm: %w", err)
	}

	now := s.now()
	nowStr := formatTime(now)
	res, err := tx.ExecContext(ctx,
		"INSERT INTO conversations (type, name, created_at) VALUES ('dm', NULL, ?)",
		nowStr)
	if err != nil {
		return Conversation{}, fmt.Errorf("insert conversation: %w", err)
	}
	convID, err = res.LastInsertId()
	if err != nil {
		return Conversation{}, fmt.Errorf("last insert id: %w", err)
	}
	for _, uid := range []int64{userA, userB} {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_delivered_message_id) VALUES (?, ?, ?, NULL)",
			convID, uid, nowStr); err != nil {
			return Conversation{}, fmt.Errorf("insert member %d: %w", uid, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return Conversation{}, fmt.Errorf("commit: %w", err)
	}
	return Conversation{
		ID:        convID,
		Type:      TypeDM,
		Name:      "",
		CreatedAt: now,
	}, nil
}

// Get returns a single conversation by ID. Returns ErrNotFound if no
// conversation with that ID exists.
func (s *Service) Get(ctx context.Context, id int64) (Conversation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Conversation{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	c, err := getConversationTx(ctx, tx, id)
	if err != nil {
		return Conversation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Conversation{}, fmt.Errorf("commit: %w", err)
	}
	return c, nil
}

// ListForUser returns every conversation userID is a member of, ordered
// by the most recent message (latest first); conversations with no
// messages yet fall to the bottom in creation order.
func (s *Service) ListForUser(ctx context.Context, userID int64) ([]Conversation, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT c.id, c.type, c.name, c.created_at,
               COALESCE(
                   (SELECT MAX(id) FROM messages WHERE conversation_id = c.id),
                   0
               ) AS last_msg_id
          FROM conversations c
          JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = ?
      ORDER BY last_msg_id DESC, c.id DESC
    `, userID)
	if err != nil {
		return nil, fmt.Errorf("query conversations: %w", err)
	}
	defer rows.Close()

	var out []Conversation
	for rows.Next() {
		var (
			c         Conversation
			name      sql.NullString
			createdAt string
			lastMsgID int64
		)
		if err := rows.Scan(&c.ID, &c.Type, &name, &createdAt, &lastMsgID); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		if name.Valid {
			c.Name = name.String
		}
		t, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse created_at: %w", err)
		}
		c.CreatedAt = t
		out = append(out, c)
	}
	return out, rows.Err()
}

// Members returns all members of a conversation, joined with their
// username for display. Order is undefined.
func (s *Service) Members(ctx context.Context, conversationID int64) ([]Member, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT m.user_id, u.username, m.joined_at, m.last_delivered_message_id
          FROM conversation_members m
          JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = ?
    `, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query members: %w", err)
	}
	defer rows.Close()

	var out []Member
	for rows.Next() {
		var (
			m             Member
			joinedAt      string
			lastDelivered sql.NullInt64
		)
		if err := rows.Scan(&m.UserID, &m.Username, &joinedAt, &lastDelivered); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		t, err := parseTime(joinedAt)
		if err != nil {
			return nil, fmt.Errorf("parse joined_at: %w", err)
		}
		m.JoinedAt = t
		if lastDelivered.Valid {
			m.LastDeliveredMessageID = lastDelivered.Int64
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// IsMember reports whether userID is a member of conversationID.
func (s *Service) IsMember(ctx context.Context, conversationID, userID int64) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		"SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
		conversationID, userID).Scan(&one)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("checking membership: %w", err)
}

// UpdateLastDelivered sets last_delivered_message_id for a member, but
// only if newID is strictly greater than the current value (so callers
// can spam it idempotently without regressing the cursor).
func (s *Service) UpdateLastDelivered(ctx context.Context, conversationID, userID, newID int64) error {
	if _, err := s.db.ExecContext(ctx, `
        UPDATE conversation_members
           SET last_delivered_message_id = ?
         WHERE conversation_id = ?
           AND user_id = ?
           AND (last_delivered_message_id IS NULL OR last_delivered_message_id < ?)
    `, newID, conversationID, userID, newID); err != nil {
		return fmt.Errorf("update last_delivered: %w", err)
	}
	return nil
}

// LastDelivered returns the last_delivered_message_id for (conversationID,
// userID). Returns 0 if no message has been delivered yet. Returns
// ErrNotMember if the (conversation, user) pair doesn't exist.
func (s *Service) LastDelivered(ctx context.Context, conversationID, userID int64) (int64, error) {
	var v sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		"SELECT last_delivered_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
		conversationID, userID).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotMember
	}
	if err != nil {
		return 0, fmt.Errorf("query last_delivered: %w", err)
	}
	if v.Valid {
		return v.Int64, nil
	}
	return 0, nil
}

func getConversationTx(ctx context.Context, tx *sql.Tx, id int64) (Conversation, error) {
	var (
		c         Conversation
		name      sql.NullString
		createdAt string
	)
	err := tx.QueryRowContext(ctx,
		"SELECT id, type, name, created_at FROM conversations WHERE id = ?",
		id).Scan(&c.ID, &c.Type, &name, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, fmt.Errorf("query conversation: %w", err)
	}
	if name.Valid {
		c.Name = name.String
	}
	t, err := parseTime(createdAt)
	if err != nil {
		return Conversation{}, fmt.Errorf("parse created_at: %w", err)
	}
	c.CreatedAt = t
	return c, nil
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

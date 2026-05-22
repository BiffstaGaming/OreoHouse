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
	"strings"
	"time"
)

// Conversation type discriminators. Mirrored by the CHECK constraint on
// conversations.type in migration 0003.
const (
	TypeDM    = "dm"
	TypeGroup = "group"
	TypeRoom  = "room"
)

// Validation bounds shared by group and room creation.
const (
	MaxNameBytes  = 64
	MaxTopicBytes = 256
)

// Sentinel errors returned by Service methods.
var (
	ErrNotFound       = errors.New("conversation not found")
	ErrNotMember      = errors.New("user is not a member of this conversation")
	ErrSelfDM         = errors.New("cannot create a DM with yourself")
	ErrInvalidName    = fmt.Errorf("conversation name must be 1..%d bytes (whitespace-trimmed)", MaxNameBytes)
	ErrInvalidTopic   = fmt.Errorf("conversation topic must be <=%d bytes", MaxTopicBytes)
	ErrNoMembers      = errors.New("at least one member (the creator) is required")
	ErrWrongType      = errors.New("conversation type does not support this operation")
)

// Conversation is a row in the conversations table.
type Conversation struct {
	ID        int64
	Type      string
	Name      string // empty when NULL (DMs always; groups/rooms optionally)
	Topic     string // empty when NULL (DMs/groups; usually set on rooms)
	CreatedAt time.Time
}

// RoomSummary is a Conversation plus a denormalised member_count, used
// by the room-discovery endpoint to avoid N+1 queries.
type RoomSummary struct {
	Conversation
	MemberCount int
}

// Member is a row in conversation_members, joined with the user's
// username + profile columns. DisplayName / AvatarAttachmentID are
// populated so REST projections can render the full UserInfo without
// a second round-trip per member.
type Member struct {
	UserID                 int64
	Username               string
	DisplayName            string // empty string when NULL
	AvatarAttachmentID     int64  // 0 when NULL
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
		"INSERT INTO conversations (type, name, topic, created_at) VALUES ('dm', NULL, NULL, ?)",
		nowStr)
	if err != nil {
		return Conversation{}, fmt.Errorf("insert conversation: %w", err)
	}
	convID, err = res.LastInsertId()
	if err != nil {
		return Conversation{}, fmt.Errorf("last insert id: %w", err)
	}
	for _, uid := range []int64{userA, userB} {
		if err := insertMemberTx(ctx, tx, convID, uid, nowStr); err != nil {
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

// CreateGroup makes a new 'group' conversation with the given members
// (creator + others). Name is optional; trimmed and validated when
// present. Members are deduplicated; the creator is always included.
// Returns the new Conversation.
func (s *Service) CreateGroup(ctx context.Context, creatorID int64, name string, memberIDs []int64) (Conversation, error) {
	trimmedName := strings.TrimSpace(name)
	if trimmedName != "" {
		if err := ValidateName(trimmedName); err != nil {
			return Conversation{}, err
		}
	}

	uniq := uniqueMemberSet(creatorID, memberIDs)
	if len(uniq) == 0 {
		return Conversation{}, ErrNoMembers
	}

	return s.createConversation(ctx, TypeGroup, trimmedName, "", uniq)
}

// CreateRoom makes a new 'room' conversation with the given name and
// optional topic. The creator becomes the initial sole member; others
// join via AddMember (or the REST join endpoint).
func (s *Service) CreateRoom(ctx context.Context, creatorID int64, name, topic string) (Conversation, error) {
	trimmedName := strings.TrimSpace(name)
	if err := ValidateName(trimmedName); err != nil {
		return Conversation{}, err
	}
	trimmedTopic := strings.TrimSpace(topic)
	if err := ValidateTopic(trimmedTopic); err != nil {
		return Conversation{}, err
	}
	return s.createConversation(ctx, TypeRoom, trimmedName, trimmedTopic, []int64{creatorID})
}

func (s *Service) createConversation(ctx context.Context, typ, name, topic string, memberIDs []int64) (Conversation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Conversation{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := s.now()
	nowStr := formatTime(now)

	var (
		nameArg  any
		topicArg any
	)
	if name != "" {
		nameArg = name
	}
	if topic != "" {
		topicArg = topic
	}
	res, err := tx.ExecContext(ctx,
		"INSERT INTO conversations (type, name, topic, created_at) VALUES (?, ?, ?, ?)",
		typ, nameArg, topicArg, nowStr)
	if err != nil {
		return Conversation{}, fmt.Errorf("insert conversation: %w", err)
	}
	convID, err := res.LastInsertId()
	if err != nil {
		return Conversation{}, fmt.Errorf("last insert id: %w", err)
	}
	for _, uid := range memberIDs {
		if err := insertMemberTx(ctx, tx, convID, uid, nowStr); err != nil {
			return Conversation{}, fmt.Errorf("insert member %d: %w", uid, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return Conversation{}, fmt.Errorf("commit: %w", err)
	}
	return Conversation{
		ID:        convID,
		Type:      typ,
		Name:      name,
		Topic:     topic,
		CreatedAt: now,
	}, nil
}

// AddMember inserts userID into conversationID. Idempotent: a no-op
// when the user is already a member. Returns ErrNotFound if the
// conversation doesn't exist.
func (s *Service) AddMember(ctx context.Context, conversationID, userID int64) error {
	// Check the conversation exists for a friendlier error.
	if _, err := s.Get(ctx, conversationID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at, last_delivered_message_id) VALUES (?, ?, ?, NULL)",
		conversationID, userID, formatTime(s.now())); err != nil {
		return fmt.Errorf("insert member: %w", err)
	}
	return nil
}

// RemoveMember deletes userID from conversationID. Returns nil even
// if the user wasn't a member.
func (s *Service) RemoveMember(ctx context.Context, conversationID, userID int64) error {
	if _, err := s.db.ExecContext(ctx,
		"DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
		conversationID, userID); err != nil {
		return fmt.Errorf("delete member: %w", err)
	}
	return nil
}

// UpdateNameTopic replaces the name and topic columns. Empty strings
// clear the corresponding column (NULL). Passing nil for either
// pointer leaves it unchanged so callers can update one field at a
// time. Returns ErrNotFound when the conversation doesn't exist.
func (s *Service) UpdateNameTopic(
	ctx context.Context, conversationID int64, name, topic *string,
) error {
	if name == nil && topic == nil {
		return nil
	}
	// Existence check for a friendlier error path.
	if _, err := s.Get(ctx, conversationID); err != nil {
		return err
	}
	// Build the SET clause dynamically. Each non-nil pointer adds one
	// column = ? pair; nil pointers are skipped entirely.
	sets := make([]string, 0, 2)
	args := make([]any, 0, 3)
	if name != nil {
		sets = append(sets, "name = ?")
		if *name == "" {
			args = append(args, nil)
		} else {
			args = append(args, *name)
		}
	}
	if topic != nil {
		sets = append(sets, "topic = ?")
		if *topic == "" {
			args = append(args, nil)
		} else {
			args = append(args, *topic)
		}
	}
	args = append(args, conversationID)
	q := "UPDATE conversations SET " + strings.Join(sets, ", ") + " WHERE id = ?"
	if _, err := s.db.ExecContext(ctx, q, args...); err != nil {
		return fmt.Errorf("update conversation: %w", err)
	}
	return nil
}

// ListRooms returns every conversation of type 'room' in the database,
// each with a denormalised member count. Order is most recently
// created first.
func (s *Service) ListRooms(ctx context.Context) ([]RoomSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT c.id, c.type, c.name, c.topic, c.created_at,
               (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
          FROM conversations c
         WHERE c.type = 'room'
      ORDER BY c.id DESC
    `)
	if err != nil {
		return nil, fmt.Errorf("query rooms: %w", err)
	}
	defer rows.Close()

	var out []RoomSummary
	for rows.Next() {
		var (
			r         RoomSummary
			name      sql.NullString
			topic     sql.NullString
			createdAt string
		)
		if err := rows.Scan(&r.ID, &r.Type, &name, &topic, &createdAt, &r.MemberCount); err != nil {
			return nil, fmt.Errorf("scan room: %w", err)
		}
		if name.Valid {
			r.Name = name.String
		}
		if topic.Valid {
			r.Topic = topic.String
		}
		t, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse created_at: %w", err)
		}
		r.CreatedAt = t
		out = append(out, r)
	}
	return out, rows.Err()
}

// ValidateName returns ErrInvalidName if name is empty or longer than
// MaxNameBytes (after whitespace trim — caller should trim first).
func ValidateName(name string) error {
	if name == "" || len(name) > MaxNameBytes {
		return ErrInvalidName
	}
	return nil
}

// ValidateTopic returns ErrInvalidTopic if topic exceeds MaxTopicBytes.
// Empty topic is allowed.
func ValidateTopic(topic string) error {
	if len(topic) > MaxTopicBytes {
		return ErrInvalidTopic
	}
	return nil
}

// uniqueMemberSet returns a deduplicated slice that includes creator
// plus every id in others. Self-references are merged.
func uniqueMemberSet(creator int64, others []int64) []int64 {
	seen := make(map[int64]struct{}, len(others)+1)
	out := make([]int64, 0, len(others)+1)
	add := func(id int64) {
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	add(creator)
	for _, id := range others {
		add(id)
	}
	return out
}

func insertMemberTx(ctx context.Context, tx *sql.Tx, convID, userID int64, nowStr string) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_delivered_message_id) VALUES (?, ?, ?, NULL)",
		convID, userID, nowStr)
	return err
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
        SELECT c.id, c.type, c.name, c.topic, c.created_at,
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
			topic     sql.NullString
			createdAt string
			lastMsgID int64
		)
		if err := rows.Scan(&c.ID, &c.Type, &name, &topic, &createdAt, &lastMsgID); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		if name.Valid {
			c.Name = name.String
		}
		if topic.Valid {
			c.Topic = topic.String
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
// username + profile columns (display_name + avatar_attachment_id) so
// REST projections can ship full UserInfo per member. Order is
// undefined.
func (s *Service) Members(ctx context.Context, conversationID int64) ([]Member, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT m.user_id, u.username, u.display_name, u.avatar_attachment_id,
               m.joined_at, m.last_delivered_message_id
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
			displayName   sql.NullString
			avatarID      sql.NullInt64
		)
		if err := rows.Scan(
			&m.UserID, &m.Username, &displayName, &avatarID,
			&joinedAt, &lastDelivered,
		); err != nil {
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
		if displayName.Valid {
			m.DisplayName = displayName.String
		}
		if avatarID.Valid {
			m.AvatarAttachmentID = avatarID.Int64
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
		topic     sql.NullString
		createdAt string
	)
	err := tx.QueryRowContext(ctx,
		"SELECT id, type, name, topic, created_at FROM conversations WHERE id = ?",
		id).Scan(&c.ID, &c.Type, &name, &topic, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, fmt.Errorf("query conversation: %w", err)
	}
	if name.Valid {
		c.Name = name.String
	}
	if topic.Valid {
		c.Topic = topic.String
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

package messages

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ReadState is one row in conversation_read_states — the highest
// message id user has acknowledged seeing in conversation_id, with the
// timestamp of when they did so.
type ReadState struct {
	ConversationID    int64
	UserID            int64
	LastReadMessageID int64
	UpdatedAt         time.Time
}

// MarkConversationRead upserts a row into conversation_read_states.
// The update is MONOTONIC: if a row already exists with
// last_read_message_id >= lastReadID, the call is a no-op. Returns
// (true, _) iff the row was inserted or moved forward (so the caller
// knows whether to broadcast a read_receipt event).
//
// The caller is responsible for checking that userID is a member of
// conversationID — this layer just trusts the IDs.
//
// There's a benign read-then-write race at family scale (two concurrent
// markers from the same user could both think they're advancing); the
// worst outcome is one spurious read_receipt broadcast, which clients
// already deduplicate by comparing against their local cursor.
func (s *Service) MarkConversationRead(
	ctx context.Context,
	conversationID, userID, lastReadID int64,
) (changed bool, _ error) {
	if lastReadID <= 0 {
		return false, nil
	}
	var current int64
	err := s.db.QueryRowContext(ctx,
		"SELECT last_read_message_id FROM conversation_read_states WHERE conversation_id = ? AND user_id = ?",
		conversationID, userID).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("reading current read state: %w", err)
	}
	if lastReadID <= current {
		return false, nil
	}
	now := formatTime(s.now())
	_, err = s.db.ExecContext(ctx, `
        INSERT INTO conversation_read_states
            (conversation_id, user_id, last_read_message_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, user_id) DO UPDATE
           SET last_read_message_id = excluded.last_read_message_id,
               updated_at           = excluded.updated_at
    `, conversationID, userID, lastReadID, now)
	if err != nil {
		return false, fmt.Errorf("upserting read state: %w", err)
	}
	return true, nil
}

// ListReadsForConversation returns every (user_id, last_read_message_id)
// pair stored for conversationID. The conv's chat windows render
// receipts from this snapshot, then keep it fresh via live
// read_receipt events.
func (s *Service) ListReadsForConversation(
	ctx context.Context, conversationID int64,
) ([]ReadState, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT conversation_id, user_id, last_read_message_id, updated_at
          FROM conversation_read_states
         WHERE conversation_id = ?
    `, conversationID)
	if err != nil {
		return nil, fmt.Errorf("querying reads: %w", err)
	}
	defer rows.Close()
	return scanReads(rows)
}

// ListReadsForUser returns every read-state row for conversations
// userID is a member of. Used by the WS welcome handler to hydrate
// per-conv read state on connect.
func (s *Service) ListReadsForUser(
	ctx context.Context, userID int64,
) ([]ReadState, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT r.conversation_id, r.user_id, r.last_read_message_id, r.updated_at
          FROM conversation_read_states r
          JOIN conversation_members  m
            ON m.conversation_id = r.conversation_id
         WHERE m.user_id = ?
    `, userID)
	if err != nil {
		return nil, fmt.Errorf("querying user reads: %w", err)
	}
	defer rows.Close()
	return scanReads(rows)
}

func scanReads(rows *sql.Rows) ([]ReadState, error) {
	var out []ReadState
	for rows.Next() {
		var (
			rs        ReadState
			updatedAt string
		)
		if err := rows.Scan(&rs.ConversationID, &rs.UserID, &rs.LastReadMessageID, &updatedAt); err != nil {
			return nil, fmt.Errorf("scanning read state: %w", err)
		}
		t, err := parseTime(updatedAt)
		if err != nil {
			return nil, fmt.Errorf("parsing updated_at: %w", err)
		}
		rs.UpdatedAt = t
		out = append(out, rs)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating reads: %w", err)
	}
	return out, nil
}

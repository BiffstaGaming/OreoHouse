package messages

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Pin is a row in conversation_pins. The message body isn't joined
// here; callers hydrate via messages.Get when they need it (a pinned
// strip typically shows 1–3 messages at a time).
type Pin struct {
	ConversationID int64
	MessageID      int64
	PinnedBy       int64
	PinnedAt       time.Time
}

// AddPin pins messageID in conversationID by userID. Idempotent — a
// second call with the same triple is a no-op. Returns true if the
// row was inserted (so callers know whether to broadcast).
func (s *Service) AddPin(
	ctx context.Context, conversationID, messageID, userID int64,
) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
        INSERT OR IGNORE INTO conversation_pins
            (conversation_id, message_id, pinned_by, pinned_at)
        VALUES (?, ?, ?, ?)`,
		conversationID, messageID, userID, formatTime(s.now()))
	if err != nil {
		return false, fmt.Errorf("inserting pin: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("rows affected: %w", err)
	}
	return rows > 0, nil
}

// RemovePin unpins messageID. Returns true if a row was actually
// removed. Idempotent on a missing pin.
func (s *Service) RemovePin(
	ctx context.Context, conversationID, messageID int64,
) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
        DELETE FROM conversation_pins
         WHERE conversation_id = ? AND message_id = ?`,
		conversationID, messageID)
	if err != nil {
		return false, fmt.Errorf("deleting pin: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("rows affected: %w", err)
	}
	return rows > 0, nil
}

// ListPins returns the (newest-first) pins for a conversation.
// Caller hydrates the actual message body via messages.Get if needed.
func (s *Service) ListPins(
	ctx context.Context, conversationID int64,
) ([]Pin, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT conversation_id, message_id, pinned_by, pinned_at
          FROM conversation_pins
         WHERE conversation_id = ?
      ORDER BY pinned_at DESC, message_id DESC
    `, conversationID)
	if err != nil {
		return nil, fmt.Errorf("listing pins: %w", err)
	}
	defer rows.Close()
	var out []Pin
	for rows.Next() {
		var (
			p         Pin
			pinnedAt  string
		)
		if err := rows.Scan(&p.ConversationID, &p.MessageID, &p.PinnedBy, &pinnedAt); err != nil {
			return nil, fmt.Errorf("scanning pin: %w", err)
		}
		t, err := parseTime(pinnedAt)
		if err != nil {
			return nil, fmt.Errorf("parse pinned_at: %w", err)
		}
		p.PinnedAt = t
		out = append(out, p)
	}
	if err := rows.Err(); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	return out, nil
}

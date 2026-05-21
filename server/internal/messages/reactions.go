package messages

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// MaxEmojiBytes caps the emoji string size to keep arbitrary blobs
// from being stored under the guise of a reaction. Real emoji are at
// most a few code points (the longest single emoji from Unicode 16 is
// ~35 bytes including ZWJ joiners).
const MaxEmojiBytes = 64

// ErrEmojiTooLong is returned when ToggleReaction is given an emoji
// string longer than MaxEmojiBytes. Also returned for empty strings.
var ErrEmojiTooLong = fmt.Errorf("emoji must be 1..%d bytes", MaxEmojiBytes)

// ReactionAction reports whether ToggleReaction added or removed the
// reaction. Returned alongside an error so the caller can broadcast
// the right side of the toggle to other members.
type ReactionAction string

const (
	ReactionAdded   ReactionAction = "add"
	ReactionRemoved ReactionAction = "remove"
)

// Reaction is one row in message_reactions. Only Emoji + UserID are
// surfaced to clients via the grouped view in MessageView.Reactions;
// the timestamp stays server-side.
type Reaction struct {
	MessageID int64
	UserID    int64
	Emoji     string
}

// ToggleReaction adds the (messageID, userID, emoji) row if absent,
// removes it if present. Returns which side of the toggle happened.
// Callers must check membership separately — this layer trusts the
// IDs.
func (s *Service) ToggleReaction(
	ctx context.Context, messageID, userID int64, emoji string,
) (ReactionAction, error) {
	if emoji == "" || len(emoji) > MaxEmojiBytes {
		return "", ErrEmojiTooLong
	}
	// Check current state first; lets us return the resulting action
	// without parsing RowsAffected on REPLACE/DELETE semantics.
	var exists int
	err := s.db.QueryRowContext(ctx, `
        SELECT 1 FROM message_reactions
         WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji).Scan(&exists)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("checking reaction: %w", err)
	}
	if exists == 1 {
		if _, err := s.db.ExecContext(ctx, `
            DELETE FROM message_reactions
             WHERE message_id = ? AND user_id = ? AND emoji = ?`,
			messageID, userID, emoji); err != nil {
			return "", fmt.Errorf("deleting reaction: %w", err)
		}
		return ReactionRemoved, nil
	}
	if _, err := s.db.ExecContext(ctx, `
        INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
        VALUES (?, ?, ?, ?)`,
		messageID, userID, emoji, formatTime(s.now())); err != nil {
		return "", fmt.Errorf("inserting reaction: %w", err)
	}
	return ReactionAdded, nil
}

// ListReactionsForMessages returns every reaction row for the given
// message IDs. Used by the REST history handler to hydrate
// MessageView.Reactions for a page in a single round-trip. Returns an
// empty (not nil) slice when no IDs are passed.
func (s *Service) ListReactionsForMessages(
	ctx context.Context, messageIDs []int64,
) ([]Reaction, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}
	// Build the IN clause with parameter placeholders. SQLite limit is
	// 32_766 host parameters; we cap our history page at MaxHistoryLimit
	// so we're nowhere near the ceiling.
	placeholders := make([]byte, 0, len(messageIDs)*2)
	args := make([]any, 0, len(messageIDs))
	for i, id := range messageIDs {
		if i > 0 {
			placeholders = append(placeholders, ',')
		}
		placeholders = append(placeholders, '?')
		args = append(args, id)
	}
	q := "SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (" +
		string(placeholders) + ")"
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("querying reactions: %w", err)
	}
	defer rows.Close()
	var out []Reaction
	for rows.Next() {
		var r Reaction
		if err := rows.Scan(&r.MessageID, &r.UserID, &r.Emoji); err != nil {
			return nil, fmt.Errorf("scanning reaction: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating reactions: %w", err)
	}
	return out, nil
}

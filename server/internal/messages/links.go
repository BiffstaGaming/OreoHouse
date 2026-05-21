package messages

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// Link is one URL found in a message body, with the context the
// client needs to render it and jump to the source message.
type Link struct {
	MessageID      int64
	ConversationID int64
	SenderID       int64
	URL            string
	CreatedAt      string // RFC3339Nano string passed straight through
}

// urlPattern is a conservative match for http/https URLs. We trim
// closing punctuation ourselves (see trimTrailingPunct) because regex
// look-arounds aren't supported in Go's stdlib regexp.
var urlPattern = regexp.MustCompile(`https?://[^\s<>"']+`)

// trailingPunct lists characters that probably belong to the
// surrounding sentence, not the URL. Trimmed after the regex match.
const trailingPunct = ".,;:!?)]}»\"'`"

// ListLinksInConversation extracts every URL from message bodies in
// the conversation, newest-first. Each (message, URL) pair becomes
// one Link row, so a message with 3 URLs contributes 3 entries.
//
// limit caps the number of MESSAGES we walk (not the number of URLs
// returned), to keep things bounded on enormous histories.
func (s *Service) ListLinksInConversation(
	ctx context.Context,
	conversationID int64,
	limit int,
) ([]Link, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `
        SELECT id, conversation_id, sender_id, body, created_at
          FROM messages
         WHERE conversation_id = ?
           AND deleted_at IS NULL
           AND body LIKE '%http%'
      ORDER BY id DESC
         LIMIT ?
    `, conversationID, limit)
	if err != nil {
		return nil, fmt.Errorf("querying messages for links: %w", err)
	}
	defer rows.Close()

	out := make([]Link, 0, 32)
	for rows.Next() {
		var (
			id        int64
			convID    int64
			senderID  int64
			body      string
			createdAt string
		)
		if err := rows.Scan(&id, &convID, &senderID, &body, &createdAt); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		for _, raw := range urlPattern.FindAllString(body, -1) {
			url := strings.TrimRight(raw, trailingPunct)
			if url == "" {
				continue
			}
			out = append(out, Link{
				MessageID:      id,
				ConversationID: convID,
				SenderID:       senderID,
				URL:            url,
				CreatedAt:      createdAt,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}


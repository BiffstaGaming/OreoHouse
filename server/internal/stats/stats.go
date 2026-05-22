// Package stats provides a one-shot snapshot of admin-dashboard
// numbers: total users, message counts, file counts and bytes,
// reactions, conversation type breakdown, and per-user activity
// figures including the last client version they signed in with.
//
// Nothing in here ever surfaces message content — the family chat's
// privacy guarantee is that admins see numbers, not text. Every
// query in this file is COUNT/SUM/MAX over rows; no message body or
// attachment filename ever leaves the database.
package stats

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Service is the stats accessor. Construct with NewService and call
// Snapshot to fetch the dashboard payload.
type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service { return &Service{db: db} }

// Snapshot is the full dashboard payload. Field types are wire-ready
// (no time.Time inside) so the REST handler can json-marshal it
// directly without reformatting.
type Snapshot struct {
	Overview  Overview  `json:"overview"`
	PerUser   []UserRow `json:"per_user"`
	GeneratedAt string  `json:"generated_at"`
}

// Overview is the family-wide totals row at the top of the dashboard.
type Overview struct {
	TotalUsers        int64 `json:"total_users"`
	AdminUsers        int64 `json:"admin_users"`
	ActiveUsers7d     int64 `json:"active_users_7d"`
	ActiveUsers30d    int64 `json:"active_users_30d"`
	TotalConversations int64 `json:"total_conversations"`
	DMConversations   int64 `json:"dm_conversations"`
	GroupConversations int64 `json:"group_conversations"`
	RoomConversations int64 `json:"room_conversations"`
	TotalMessages     int64 `json:"total_messages"`
	Messages7d        int64 `json:"messages_7d"`
	Messages30d       int64 `json:"messages_30d"`
	TotalReactions    int64 `json:"total_reactions"`
	TotalAttachments  int64 `json:"total_attachments"`
	ImageAttachments  int64 `json:"image_attachments"`
	OtherAttachments  int64 `json:"other_attachments"`
	TotalUploadBytes  int64 `json:"total_upload_bytes"`
	DeletedMessages   int64 `json:"deleted_messages"`
	EditedMessages    int64 `json:"edited_messages"`
	PinnedMessages    int64 `json:"pinned_messages"`
}

// UserRow is one row in the per-user activity table. Every field is
// a number except username and client_version (free-form strings
// already in the DB).
type UserRow struct {
	ID                 int64  `json:"id"`
	Username           string `json:"username"`
	IsAdmin            bool   `json:"is_admin"`
	MessagesSent       int64  `json:"messages_sent"`
	AttachmentsUploaded int64 `json:"attachments_uploaded"`
	BytesUploaded      int64  `json:"bytes_uploaded"`
	ReactionsGiven     int64  `json:"reactions_given"`
	ConversationsIn    int64  `json:"conversations_in"`
	LastSeenAt         string `json:"last_seen_at,omitempty"`
	LatestClientVersion string `json:"latest_client_version,omitempty"`
}

// Snapshot runs every dashboard query in one logical batch and
// returns the assembled payload. Each query is independently cheap
// (COUNT / SUM on indexed columns) so there's no point in
// transactions — slight inter-query skew is fine for a dashboard.
func (s *Service) Snapshot(ctx context.Context) (Snapshot, error) {
	out := Snapshot{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}

	now := time.Now().UTC()
	cutoff7d := now.AddDate(0, 0, -7).Format(time.RFC3339Nano)
	cutoff30d := now.AddDate(0, 0, -30).Format(time.RFC3339Nano)

	// --- overview ------------------------------------------------------

	row := func(q string, args ...any) *sql.Row {
		return s.db.QueryRowContext(ctx, q, args...)
	}
	scan := func(dst *int64, q string, args ...any) error {
		var n sql.NullInt64
		if err := row(q, args...).Scan(&n); err != nil {
			return fmt.Errorf("%s: %w", q, err)
		}
		if n.Valid {
			*dst = n.Int64
		}
		return nil
	}

	if err := scan(&out.Overview.TotalUsers, "SELECT COUNT(*) FROM users"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.AdminUsers, "SELECT COUNT(*) FROM users WHERE is_admin = 1"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.ActiveUsers7d, "SELECT COUNT(*) FROM users WHERE last_seen_at >= ?", cutoff7d); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.ActiveUsers30d, "SELECT COUNT(*) FROM users WHERE last_seen_at >= ?", cutoff30d); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.TotalConversations, "SELECT COUNT(*) FROM conversations"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.DMConversations, "SELECT COUNT(*) FROM conversations WHERE type = 'dm'"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.GroupConversations, "SELECT COUNT(*) FROM conversations WHERE type = 'group'"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.RoomConversations, "SELECT COUNT(*) FROM conversations WHERE type = 'room'"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.TotalMessages, "SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.Messages7d, "SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL AND created_at >= ?", cutoff7d); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.Messages30d, "SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL AND created_at >= ?", cutoff30d); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.TotalReactions, "SELECT COUNT(*) FROM message_reactions"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.TotalAttachments, "SELECT COUNT(*) FROM attachments WHERE message_id IS NOT NULL"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.ImageAttachments,
		"SELECT COUNT(*) FROM attachments WHERE message_id IS NOT NULL AND mime_type LIKE 'image/%'",
	); err != nil {
		return out, err
	}
	out.Overview.OtherAttachments = out.Overview.TotalAttachments - out.Overview.ImageAttachments
	if err := scan(&out.Overview.TotalUploadBytes,
		"SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE message_id IS NOT NULL",
	); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.DeletedMessages, "SELECT COUNT(*) FROM messages WHERE deleted_at IS NOT NULL"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.EditedMessages, "SELECT COUNT(*) FROM messages WHERE edited_at IS NOT NULL AND deleted_at IS NULL"); err != nil {
		return out, err
	}
	if err := scan(&out.Overview.PinnedMessages, "SELECT COUNT(*) FROM conversation_pins"); err != nil {
		return out, err
	}

	// --- per-user ------------------------------------------------------
	//
	// One left-joined query so we get a row per user even if they've
	// never posted. The subqueries are correlated against the user_id
	// and indexed on the relevant fk columns.

	rows, err := s.db.QueryContext(ctx, `
        SELECT
            u.id,
            u.username,
            u.is_admin,
            u.last_seen_at,
            (SELECT COUNT(*) FROM messages         WHERE sender_id = u.id AND deleted_at IS NULL) AS messages_sent,
            (SELECT COUNT(*) FROM attachments      WHERE uploader_id = u.id AND message_id IS NOT NULL) AS attachments_uploaded,
            (SELECT COALESCE(SUM(size_bytes),0) FROM attachments WHERE uploader_id = u.id AND message_id IS NOT NULL) AS bytes_uploaded,
            (SELECT COUNT(*) FROM message_reactions WHERE user_id = u.id) AS reactions_given,
            (SELECT COUNT(*) FROM conversation_members WHERE user_id = u.id) AS conversations_in,
            (SELECT client_version FROM sessions WHERE user_id = u.id AND client_version IS NOT NULL
              ORDER BY created_at DESC LIMIT 1) AS latest_client_version
          FROM users u
      ORDER BY u.username COLLATE NOCASE ASC
    `)
	if err != nil {
		return out, fmt.Errorf("per-user query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			ur          UserRow
			lastSeen    sql.NullString
			clientVer   sql.NullString
			isAdminInt  int64
		)
		if err := rows.Scan(
			&ur.ID, &ur.Username, &isAdminInt, &lastSeen,
			&ur.MessagesSent, &ur.AttachmentsUploaded, &ur.BytesUploaded,
			&ur.ReactionsGiven, &ur.ConversationsIn, &clientVer,
		); err != nil {
			return out, fmt.Errorf("per-user scan: %w", err)
		}
		ur.IsAdmin = isAdminInt != 0
		if lastSeen.Valid {
			ur.LastSeenAt = lastSeen.String
		}
		if clientVer.Valid {
			ur.LatestClientVersion = clientVer.String
		}
		out.PerUser = append(out.PerUser, ur)
	}
	return out, rows.Err()
}

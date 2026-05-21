// Package attachments stores user-uploaded files on the local
// filesystem and tracks them in the attachments table.
//
// Files are written into <upload_dir>/<random-name> with the original
// filename + MIME type kept as metadata. An attachment starts life
// with message_id = NULL ("orphan upload") and is linked to a message
// by Attach once the sender commits a chat message that references it.
package attachments

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // register decoders for image.DecodeConfig
	_ "image/jpeg" //
	_ "image/png"  //
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "golang.org/x/image/webp" // register webp decoder
)

// Sentinel errors returned by Service methods.
var (
	ErrNotFound        = errors.New("attachment not found")
	ErrTooLarge        = errors.New("attachment exceeds size limit")
	ErrAlreadyAttached = errors.New("attachment is already linked to a message")
	ErrNotUploader     = errors.New("attachment belongs to a different user")
)

// Attachment is one row in the attachments table plus the on-disk
// storage path.
type Attachment struct {
	ID          int64
	UploaderID  int64
	MessageID   int64 // 0 when NULL (not yet attached)
	Filename    string
	MimeType    string
	SizeBytes   int64
	ImageWidth  int // 0 if not an image or dimensions unknown
	ImageHeight int
	StoragePath string // relative to the service's upload dir
	CreatedAt   time.Time
}

// IsImage reports whether the attachment's MIME type starts with
// "image/" (the only kind the client previews inline).
func (a Attachment) IsImage() bool {
	return strings.HasPrefix(a.MimeType, "image/")
}

// Service is the attachments-related accessor.
type Service struct {
	db        *sql.DB
	uploadDir string
	now       func() time.Time
}

// NewService returns a Service that persists rows via db and files
// under uploadDir (created if missing).
func NewService(db *sql.DB, uploadDir string) (*Service, error) {
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating upload dir %q: %w", uploadDir, err)
	}
	return &Service{
		db:        db,
		uploadDir: uploadDir,
		now:       func() time.Time { return time.Now().UTC() },
	}, nil
}

// UploadDir returns the absolute (or whatever was passed in) upload
// directory the service writes into. Exported so the REST handler can
// log it on startup.
func (s *Service) UploadDir() string { return s.uploadDir }

// Store streams body to a random file under the upload dir, capped at
// maxBytes, and inserts an attachments row owned by uploaderID with
// message_id = NULL. For image MIME types it also reads back enough of
// the file to extract width/height via image.DecodeConfig.
//
// Returns ErrTooLarge if body produces more than maxBytes bytes.
func (s *Service) Store(
	ctx context.Context,
	uploaderID int64,
	filename, mimeType string,
	body io.Reader,
	maxBytes int64,
) (Attachment, error) {
	storageName, err := newStorageName()
	if err != nil {
		return Attachment{}, fmt.Errorf("generating storage name: %w", err)
	}
	fullPath := filepath.Join(s.uploadDir, storageName)

	f, err := os.OpenFile(fullPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return Attachment{}, fmt.Errorf("creating upload file: %w", err)
	}
	cleanup := func() {
		_ = os.Remove(fullPath)
	}

	// Read maxBytes+1 so we can detect over-cap inputs without trusting
	// any Content-Length headers from the caller.
	limited := io.LimitReader(body, maxBytes+1)
	n, copyErr := io.Copy(f, limited)
	if closeErr := f.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		cleanup()
		return Attachment{}, fmt.Errorf("writing upload: %w", copyErr)
	}
	if n > maxBytes {
		cleanup()
		return Attachment{}, ErrTooLarge
	}

	width, height := 0, 0
	if strings.HasPrefix(mimeType, "image/") {
		width, height = detectImageDimensions(fullPath)
	}

	now := s.now()
	res, err := s.db.ExecContext(ctx, `
        INSERT INTO attachments
            (uploader_id, message_id, filename, mime_type, size_bytes,
             image_width, image_height, storage_path, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `,
		uploaderID, filename, mimeType, n,
		nullableInt(width), nullableInt(height),
		storageName, formatTime(now),
	)
	if err != nil {
		cleanup()
		return Attachment{}, fmt.Errorf("inserting attachment row: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		cleanup()
		return Attachment{}, fmt.Errorf("last insert id: %w", err)
	}
	return Attachment{
		ID:          id,
		UploaderID:  uploaderID,
		Filename:    filename,
		MimeType:    mimeType,
		SizeBytes:   n,
		ImageWidth:  width,
		ImageHeight: height,
		StoragePath: storageName,
		CreatedAt:   now,
	}, nil
}

// Get returns the attachment row by id; ErrNotFound if absent.
func (s *Service) Get(ctx context.Context, id int64) (Attachment, error) {
	var (
		a         Attachment
		messageID sql.NullInt64
		imgW      sql.NullInt64
		imgH      sql.NullInt64
		createdAt string
	)
	err := s.db.QueryRowContext(ctx, `
        SELECT id, uploader_id, message_id, filename, mime_type,
               size_bytes, image_width, image_height, storage_path,
               created_at
          FROM attachments
         WHERE id = ?
    `, id).Scan(
		&a.ID, &a.UploaderID, &messageID, &a.Filename, &a.MimeType,
		&a.SizeBytes, &imgW, &imgH, &a.StoragePath, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Attachment{}, ErrNotFound
	}
	if err != nil {
		return Attachment{}, fmt.Errorf("querying attachment: %w", err)
	}
	if messageID.Valid {
		a.MessageID = messageID.Int64
	}
	if imgW.Valid {
		a.ImageWidth = int(imgW.Int64)
	}
	if imgH.Valid {
		a.ImageHeight = int(imgH.Int64)
	}
	t, err := parseTime(createdAt)
	if err != nil {
		return Attachment{}, fmt.Errorf("parsing created_at: %w", err)
	}
	a.CreatedAt = t
	return a, nil
}

// Open returns the attachment row plus an open *os.File positioned at
// the start. Caller must Close the file.
func (s *Service) Open(ctx context.Context, id int64) (*os.File, Attachment, error) {
	a, err := s.Get(ctx, id)
	if err != nil {
		return nil, Attachment{}, err
	}
	full := filepath.Join(s.uploadDir, a.StoragePath)
	f, err := os.Open(full)
	if err != nil {
		return nil, Attachment{}, fmt.Errorf("opening %s: %w", full, err)
	}
	return f, a, nil
}

// Attach links attachmentID to messageID, but only if:
//   - the attachment exists,
//   - it isn't already linked to a message, and
//   - its uploader matches senderID.
//
// Returns one of ErrNotFound, ErrAlreadyAttached, ErrNotUploader on
// failure.
func (s *Service) Attach(ctx context.Context, attachmentID, messageID, senderID int64) error {
	a, err := s.Get(ctx, attachmentID)
	if err != nil {
		return err
	}
	if a.UploaderID != senderID {
		return ErrNotUploader
	}
	if a.MessageID != 0 {
		return ErrAlreadyAttached
	}
	if _, err := s.db.ExecContext(ctx,
		"UPDATE attachments SET message_id = ? WHERE id = ?",
		messageID, attachmentID,
	); err != nil {
		return fmt.Errorf("linking attachment %d to message %d: %w", attachmentID, messageID, err)
	}
	return nil
}

// ListForMessages returns the attachments for every messageID in one
// query, indexed by message ID. Used to hydrate message history pages
// and replay batches without N+1 queries.
func (s *Service) ListForMessages(ctx context.Context, messageIDs []int64) (map[int64][]Attachment, error) {
	out := make(map[int64][]Attachment)
	if len(messageIDs) == 0 {
		return out, nil
	}
	placeholders := strings.Repeat(",?", len(messageIDs))[1:]
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
	}
	rows, err := s.db.QueryContext(ctx, `
        SELECT id, uploader_id, message_id, filename, mime_type,
               size_bytes, image_width, image_height, storage_path,
               created_at
          FROM attachments
         WHERE message_id IN (`+placeholders+`)
      ORDER BY id ASC
    `, args...)
	if err != nil {
		return nil, fmt.Errorf("querying attachments by messages: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			a         Attachment
			messageID sql.NullInt64
			imgW      sql.NullInt64
			imgH      sql.NullInt64
			createdAt string
		)
		if err := rows.Scan(
			&a.ID, &a.UploaderID, &messageID, &a.Filename, &a.MimeType,
			&a.SizeBytes, &imgW, &imgH, &a.StoragePath, &createdAt,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		if messageID.Valid {
			a.MessageID = messageID.Int64
		}
		if imgW.Valid {
			a.ImageWidth = int(imgW.Int64)
		}
		if imgH.Valid {
			a.ImageHeight = int(imgH.Int64)
		}
		t, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse created_at: %w", err)
		}
		a.CreatedAt = t
		out[a.MessageID] = append(out[a.MessageID], a)
	}
	return out, rows.Err()
}

func nullableInt(v int) any {
	if v <= 0 {
		return nil
	}
	return v
}

func newStorageName() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func detectImageDimensions(path string) (int, int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
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

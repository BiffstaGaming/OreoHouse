package attachments

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
)

type stack struct {
	db    *sql.DB
	auth  *auth.Service
	convs *conversations.Service
	msgs  *messages.Service
	svc   *Service
	dir   string
}

func newStack(t *testing.T) *stack {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(ctx, d, server.Migrations()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })

	dir := t.TempDir()
	svc, err := NewService(d, dir)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return &stack{
		db:    d,
		auth:  auth.NewService(d, 0),
		convs: conversations.NewService(d),
		msgs:  messages.NewService(d),
		svc:   svc,
		dir:   dir,
	}
}

func (s *stack) seedUser(t *testing.T, username string) auth.User {
	t.Helper()
	u, err := s.auth.CreateUser(context.Background(), username, "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	return u
}

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png encode: %v", err)
	}
	return buf.Bytes()
}

func TestStore_PersistsFileAndRow(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	ctx := context.Background()

	body := []byte("hello bytes")
	a, err := s.svc.Store(ctx, alice.ID, "note.txt", "text/plain", bytes.NewReader(body), 1024)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}
	if a.ID == 0 || a.UploaderID != alice.ID {
		t.Errorf("unexpected attachment: %+v", a)
	}
	if a.SizeBytes != int64(len(body)) {
		t.Errorf("size: got %d, want %d", a.SizeBytes, len(body))
	}
	if a.MessageID != 0 {
		t.Errorf("expected message_id NULL → 0, got %d", a.MessageID)
	}

	fullPath := filepath.Join(s.dir, a.StoragePath)
	got, err := os.ReadFile(fullPath)
	if err != nil {
		t.Fatalf("read on-disk: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("on-disk bytes differ")
	}
}

func TestStore_RejectsOverCapAndCleansUp(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	ctx := context.Background()

	_, err := s.svc.Store(ctx, alice.ID, "big.txt", "text/plain", bytes.NewReader(make([]byte, 100)), 10)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
	// Upload dir should be clean (no leftover from the failed write).
	entries, _ := os.ReadDir(s.dir)
	if len(entries) != 0 {
		t.Errorf("expected upload dir to be clean after failure, got %d entries", len(entries))
	}
}

func TestStore_ExtractsImageDimensions(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	ctx := context.Background()

	body := makePNG(t, 16, 9)
	a, err := s.svc.Store(ctx, alice.ID, "tiny.png", "image/png", bytes.NewReader(body), 1<<20)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}
	if a.ImageWidth != 16 || a.ImageHeight != 9 {
		t.Errorf("expected 16x9 dims, got %dx%d", a.ImageWidth, a.ImageHeight)
	}
	if !a.IsImage() {
		t.Errorf("expected IsImage to be true for image/png")
	}
}

func TestGet_RoundTripsAttachment(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	ctx := context.Background()

	created, err := s.svc.Store(ctx, alice.ID, "x.bin", "application/octet-stream", strings.NewReader("xyz"), 1024)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}
	got, err := s.svc.Get(ctx, created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Filename != "x.bin" || got.MimeType != "application/octet-stream" || got.SizeBytes != 3 {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestGet_ErrNotFound(t *testing.T) {
	s := newStack(t)
	if _, err := s.svc.Get(context.Background(), 99999); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestOpen_ReturnsFileBytes(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	ctx := context.Background()

	a, _ := s.svc.Store(ctx, alice.ID, "f", "text/plain", strings.NewReader("hello"), 1024)
	f, meta, err := s.svc.Open(ctx, a.ID)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer f.Close()
	if meta.ID != a.ID {
		t.Errorf("meta mismatch")
	}
	body, _ := io.ReadAll(f)
	if string(body) != "hello" {
		t.Errorf("file bytes: got %q, want hello", body)
	}
}

func TestAttach_LinksOnlyOnceAndOnlyForUploader(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()

	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	m, _ := s.msgs.Send(ctx, c.ID, alice.ID, "hi")

	a, _ := s.svc.Store(ctx, alice.ID, "f", "text/plain", strings.NewReader("hi"), 1024)

	// Wrong uploader → ErrNotUploader.
	if err := s.svc.Attach(ctx, a.ID, m.ID, bob.ID); !errors.Is(err, ErrNotUploader) {
		t.Errorf("expected ErrNotUploader, got %v", err)
	}

	// Correct uploader → ok.
	if err := s.svc.Attach(ctx, a.ID, m.ID, alice.ID); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	// Re-attach → ErrAlreadyAttached.
	if err := s.svc.Attach(ctx, a.ID, m.ID, alice.ID); !errors.Is(err, ErrAlreadyAttached) {
		t.Errorf("expected ErrAlreadyAttached, got %v", err)
	}

	// And Get reflects message_id now set.
	got, _ := s.svc.Get(ctx, a.ID)
	if got.MessageID != m.ID {
		t.Errorf("expected message_id=%d after attach, got %d", m.ID, got.MessageID)
	}
}

func TestAttach_NotFound(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	if err := s.svc.Attach(context.Background(), 99999, 1, alice.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestListForMessages_GroupsAndOrders(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()

	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	m1, _ := s.msgs.Send(ctx, c.ID, alice.ID, "m1")
	m2, _ := s.msgs.Send(ctx, c.ID, alice.ID, "m2")

	for _, mid := range []int64{m1.ID, m1.ID, m2.ID} {
		a, _ := s.svc.Store(ctx, alice.ID, "f", "text/plain", strings.NewReader("x"), 1024)
		if err := s.svc.Attach(ctx, a.ID, mid, alice.ID); err != nil {
			t.Fatalf("Attach: %v", err)
		}
	}

	got, err := s.svc.ListForMessages(ctx, []int64{m1.ID, m2.ID})
	if err != nil {
		t.Fatalf("ListForMessages: %v", err)
	}
	if len(got[m1.ID]) != 2 {
		t.Errorf("m1: expected 2 attachments, got %d", len(got[m1.ID]))
	}
	if len(got[m2.ID]) != 1 {
		t.Errorf("m2: expected 1 attachment, got %d", len(got[m2.ID]))
	}
}

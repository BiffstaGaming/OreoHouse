package messages

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
)

type stack struct {
	db    *sql.DB
	auth  *auth.Service
	convs *conversations.Service
	svc   *Service
}

func newStack(t *testing.T) *stack {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(ctx, d, server.Migrations()); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return &stack{
		db:    d,
		auth:  auth.NewService(d, 0),
		convs: conversations.NewService(d),
		svc:   NewService(d),
	}
}

// seedDM creates two users and a DM between them, returning the
// conversation ID plus alice's user.User.
func (s *stack) seedDM(t *testing.T) (convID int64, alice, bob auth.User) {
	t.Helper()
	ctx := context.Background()
	alice, err := s.auth.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser alice: %v", err)
	}
	bob, err = s.auth.CreateUser(ctx, "bob", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser bob: %v", err)
	}
	c, err := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("FindOrCreateDM: %v", err)
	}
	return c.ID, alice, bob
}

func TestValidateBody(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want error
	}{
		{"empty (allowed since Phase 5)", "", nil},
		{"ok short", "hi", nil},
		{"at max", strings.Repeat("a", MaxBodyBytes), nil},
		{"over max", strings.Repeat("a", MaxBodyBytes+1), ErrBodyTooLong},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ValidateBody(tc.in)
			if !errors.Is(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSend_PersistsMessage(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()

	m, err := s.svc.Send(ctx, convID, alice.ID, "hello bob")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if m.ID == 0 {
		t.Errorf("expected non-zero ID")
	}
	if m.ConversationID != convID || m.SenderID != alice.ID || m.Body != "hello bob" {
		t.Errorf("unexpected message: %+v", m)
	}

	// Round-trip via HistoryPage.
	got, err := s.svc.HistoryPage(ctx, convID, 0, 10)
	if err != nil {
		t.Fatalf("HistoryPage: %v", err)
	}
	if len(got) != 1 || got[0].Body != "hello bob" {
		t.Errorf("expected one round-tripped message, got %+v", got)
	}
}

func TestSend_RejectsOversizeBody(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()

	if _, err := s.svc.Send(ctx, convID, alice.ID, strings.Repeat("a", MaxBodyBytes+1)); !errors.Is(err, ErrBodyTooLong) {
		t.Errorf("expected ErrBodyTooLong, got %v", err)
	}
}

func TestSend_AllowsEmptyBody(t *testing.T) {
	// Phase 5: an attachment-only message has body == "".
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()
	if _, err := s.svc.Send(ctx, convID, alice.ID, ""); err != nil {
		t.Errorf("expected empty body to be allowed, got %v", err)
	}
}

func TestHistoryPage_NewestFirstAndRespectsLimit(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()

	for i := 1; i <= 5; i++ {
		if _, err := s.svc.Send(ctx, convID, alice.ID, "m"); err != nil {
			t.Fatalf("Send %d: %v", i, err)
		}
	}
	page, err := s.svc.HistoryPage(ctx, convID, 0, 3)
	if err != nil {
		t.Fatalf("HistoryPage: %v", err)
	}
	if len(page) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(page))
	}
	if !(page[0].ID > page[1].ID && page[1].ID > page[2].ID) {
		t.Errorf("expected DESC by id, got %d, %d, %d", page[0].ID, page[1].ID, page[2].ID)
	}
}

func TestHistoryPage_RespectsBeforeID(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()

	var ids []int64
	for i := 0; i < 5; i++ {
		m, err := s.svc.Send(ctx, convID, alice.ID, "m")
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
		ids = append(ids, m.ID)
	}
	// First page (newest two).
	first, _ := s.svc.HistoryPage(ctx, convID, 0, 2)
	if len(first) != 2 || first[0].ID != ids[4] || first[1].ID != ids[3] {
		t.Fatalf("first page wrong: %+v", first)
	}
	// Second page using before = id of the oldest item in the first page.
	second, _ := s.svc.HistoryPage(ctx, convID, first[len(first)-1].ID, 2)
	if len(second) != 2 || second[0].ID != ids[2] || second[1].ID != ids[1] {
		t.Errorf("second page wrong: %+v", second)
	}
}

func TestHistoryPage_ClampsLimit(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()

	// 250 messages > MaxHistoryLimit (200) — only the most recent 200 returned.
	for i := 0; i < MaxHistoryLimit+50; i++ {
		_, _ = s.svc.Send(ctx, convID, alice.ID, "m")
	}
	page, err := s.svc.HistoryPage(ctx, convID, 0, 0) // limit=0 → DefaultHistoryLimit
	if err != nil {
		t.Fatalf("HistoryPage: %v", err)
	}
	if len(page) != DefaultHistoryLimit {
		t.Errorf("expected DefaultHistoryLimit (%d), got %d", DefaultHistoryLimit, len(page))
	}
	page2, _ := s.svc.HistoryPage(ctx, convID, 0, 1000)
	if len(page2) != MaxHistoryLimit {
		t.Errorf("expected limit clamped to MaxHistoryLimit (%d), got %d", MaxHistoryLimit, len(page2))
	}
}

func TestSince_AscendingAndExcludesAtOrBefore(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()

	var ids []int64
	for i := 0; i < 5; i++ {
		m, err := s.svc.Send(ctx, convID, alice.ID, "m")
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
		ids = append(ids, m.ID)
	}

	got, err := s.svc.Since(ctx, convID, ids[1], 0) // skip the first two
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 messages after ids[1], got %d", len(got))
	}
	if got[0].ID != ids[2] || got[1].ID != ids[3] || got[2].ID != ids[4] {
		t.Errorf("expected ascending order, got %v", []int64{got[0].ID, got[1].ID, got[2].ID})
	}
}

func TestSince_ReturnsAllWhenSinceIsZero(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		_, _ = s.svc.Send(ctx, convID, alice.ID, "m")
	}
	got, err := s.svc.Since(ctx, convID, 0, 0)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("expected 3 messages, got %d", len(got))
	}
}

func TestSince_RespectsLimit(t *testing.T) {
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		_, _ = s.svc.Send(ctx, convID, alice.ID, "m")
	}
	got, err := s.svc.Since(ctx, convID, 0, 4)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(got) != 4 {
		t.Errorf("expected 4 messages, got %d", len(got))
	}
}

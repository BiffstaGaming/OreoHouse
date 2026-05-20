package conversations

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
)

// stack returns a fresh in-memory DB with migrations applied, an auth
// service, and a conversations service. Tests use this to set up users
// for FindOrCreateDM and friends.
type stack struct {
	db   *sql.DB
	auth *auth.Service
	svc  *Service
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
		db:   d,
		auth: auth.NewService(d, 0),
		svc:  NewService(d),
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

// insertMessage skips the messages package (which doesn't exist yet at
// this commit boundary) and pokes the schema directly so we can
// exercise ListForUser ordering.
func (s *stack) insertMessage(t *testing.T, conversationID, senderID int64) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.Exec(
		"INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)",
		conversationID, senderID, "hi", now,
	); err != nil {
		t.Fatalf("insert message: %v", err)
	}
}

func TestFindOrCreateDM_CreatesNewConversation(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")

	c, err := s.svc.FindOrCreateDM(context.Background(), alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("FindOrCreateDM: %v", err)
	}
	if c.ID == 0 {
		t.Errorf("expected non-zero conversation ID")
	}
	if c.Type != TypeDM {
		t.Errorf("expected type=dm, got %q", c.Type)
	}
	if c.Name != "" {
		t.Errorf("expected empty name for DM, got %q", c.Name)
	}

	members, err := s.svc.Members(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("expected 2 members, got %d", len(members))
	}
	gotIDs := map[int64]bool{}
	for _, m := range members {
		gotIDs[m.UserID] = true
	}
	if !gotIDs[alice.ID] || !gotIDs[bob.ID] {
		t.Errorf("expected members alice and bob, got %+v", members)
	}
}

func TestFindOrCreateDM_FindsExisting(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()

	c1, err := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("first FindOrCreateDM: %v", err)
	}
	c2, err := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("second FindOrCreateDM: %v", err)
	}
	if c1.ID != c2.ID {
		t.Errorf("expected same conversation, got %d != %d", c1.ID, c2.ID)
	}
}

func TestFindOrCreateDM_OrderInvariant(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()

	c1, err := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("a,b: %v", err)
	}
	c2, err := s.svc.FindOrCreateDM(ctx, bob.ID, alice.ID)
	if err != nil {
		t.Fatalf("b,a: %v", err)
	}
	if c1.ID != c2.ID {
		t.Errorf("expected (a,b) and (b,a) to resolve to same DM, got %d != %d", c1.ID, c2.ID)
	}
}

func TestFindOrCreateDM_RejectsSelf(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	_, err := s.svc.FindOrCreateDM(context.Background(), alice.ID, alice.ID)
	if !errors.Is(err, ErrSelfDM) {
		t.Errorf("expected ErrSelfDM, got %v", err)
	}
}

func TestGet_ReturnsConversationAndErrNotFoundOtherwise(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()

	c, err := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("FindOrCreateDM: %v", err)
	}
	got, err := s.svc.Get(ctx, c.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ID != c.ID || got.Type != TypeDM {
		t.Errorf("Get: got %+v, want id=%d type=dm", got, c.ID)
	}
	if _, err := s.svc.Get(ctx, 99999); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound for unknown id, got %v", err)
	}
}

func TestListForUser_OrdersByLatestMessage(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	carol := s.seedUser(t, "carol")
	ctx := context.Background()

	// alice has two DMs: with bob (older) and with carol (newer).
	convAB, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	convAC, _ := s.svc.FindOrCreateDM(ctx, alice.ID, carol.ID)

	// Old message in AB, then a newer one in AC.
	s.insertMessage(t, convAB.ID, alice.ID)
	s.insertMessage(t, convAC.ID, alice.ID)

	list, err := s.svc.ListForUser(ctx, alice.ID)
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 conversations, got %d", len(list))
	}
	if list[0].ID != convAC.ID {
		t.Errorf("expected newest first (AC), got order %v", list)
	}
}

func TestListForUser_ConversationsWithoutMessagesAppearAfter(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	carol := s.seedUser(t, "carol")
	ctx := context.Background()

	convAB, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	convAC, _ := s.svc.FindOrCreateDM(ctx, alice.ID, carol.ID)

	// Only AB has a message.
	s.insertMessage(t, convAB.ID, alice.ID)

	list, err := s.svc.ListForUser(ctx, alice.ID)
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if len(list) != 2 || list[0].ID != convAB.ID || list[1].ID != convAC.ID {
		t.Errorf("expected AB before AC, got %v", list)
	}
}

func TestIsMember(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	carol := s.seedUser(t, "carol")
	ctx := context.Background()

	c, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	for _, tc := range []struct {
		uid  int64
		want bool
	}{
		{alice.ID, true},
		{bob.ID, true},
		{carol.ID, false},
	} {
		got, err := s.svc.IsMember(ctx, c.ID, tc.uid)
		if err != nil {
			t.Fatalf("IsMember(%d): %v", tc.uid, err)
		}
		if got != tc.want {
			t.Errorf("IsMember(%d): got %v, want %v", tc.uid, got, tc.want)
		}
	}
}

func TestUpdateLastDelivered_AdvancesForward(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()
	c, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)

	if err := s.svc.UpdateLastDelivered(ctx, c.ID, alice.ID, 10); err != nil {
		t.Fatalf("UpdateLastDelivered: %v", err)
	}
	v, err := s.svc.LastDelivered(ctx, c.ID, alice.ID)
	if err != nil {
		t.Fatalf("LastDelivered: %v", err)
	}
	if v != 10 {
		t.Errorf("expected 10, got %d", v)
	}
}

func TestUpdateLastDelivered_DoesNotRegress(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()
	c, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)

	if err := s.svc.UpdateLastDelivered(ctx, c.ID, alice.ID, 20); err != nil {
		t.Fatalf("first UpdateLastDelivered: %v", err)
	}
	if err := s.svc.UpdateLastDelivered(ctx, c.ID, alice.ID, 5); err != nil {
		t.Fatalf("regress attempt: %v", err)
	}
	v, _ := s.svc.LastDelivered(ctx, c.ID, alice.ID)
	if v != 20 {
		t.Errorf("expected 20 (no regression), got %d", v)
	}
}

func TestLastDelivered_ReturnsZeroForFreshMember(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	ctx := context.Background()
	c, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	v, err := s.svc.LastDelivered(ctx, c.ID, alice.ID)
	if err != nil {
		t.Fatalf("LastDelivered: %v", err)
	}
	if v != 0 {
		t.Errorf("expected 0 for fresh member, got %d", v)
	}
}

func TestLastDelivered_ErrNotMember(t *testing.T) {
	s := newStack(t)
	alice := s.seedUser(t, "alice")
	bob := s.seedUser(t, "bob")
	carol := s.seedUser(t, "carol")
	ctx := context.Background()
	c, _ := s.svc.FindOrCreateDM(ctx, alice.ID, bob.ID)
	_, err := s.svc.LastDelivered(ctx, c.ID, carol.ID)
	if !errors.Is(err, ErrNotMember) {
		t.Errorf("expected ErrNotMember, got %v", err)
	}
}

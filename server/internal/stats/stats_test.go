package stats

import (
	"context"
	"strings"
	"testing"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
)

// End-to-end smoke test: spin up an in-memory DB, seed two users + a
// DM + a couple of messages + an attachment, and assert the snapshot
// totals + per-user fields come out right. Covers the client_version
// flow too (alice has one, bob doesn't).
func TestSnapshot_AggregatesEverything(t *testing.T) {
	d, err := db.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(context.Background(), d, server.Migrations()); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	ctx := context.Background()
	authSvc := auth.NewService(d, 0)
	convs := conversations.NewService(d)
	msgs := messages.NewService(d)
	att, err := attachments.NewService(d, t.TempDir())
	if err != nil {
		t.Fatalf("attachments.NewService: %v", err)
	}

	alice, err := authSvc.CreateUser(ctx, "alice", "longenoughpw")
	if err != nil {
		t.Fatalf("CreateUser alice: %v", err)
	}
	bob, err := authSvc.CreateUser(ctx, "bob", "longenoughpw")
	if err != nil {
		t.Fatalf("CreateUser bob: %v", err)
	}
	// alice logs in with a tagged version; bob without.
	if _, err := authSvc.CreateSessionWithVersion(ctx, alice.ID, "desktop 0.18.1"); err != nil {
		t.Fatalf("CreateSessionWithVersion: %v", err)
	}
	if _, err := authSvc.CreateSession(ctx, bob.ID); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// A DM and a few messages.
	c, err := convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("FindOrCreateDM: %v", err)
	}
	if _, err := msgs.Send(ctx, c.ID, alice.ID, "hi"); err != nil {
		t.Fatalf("Send 1: %v", err)
	}
	if _, err := msgs.Send(ctx, c.ID, alice.ID, "how are you"); err != nil {
		t.Fatalf("Send 2: %v", err)
	}
	mb, err := msgs.Send(ctx, c.ID, bob.ID, "good thanks")
	if err != nil {
		t.Fatalf("Send 3: %v", err)
	}

	// Attach a file to bob's message.
	a, err := att.Store(ctx, bob.ID, "x.txt", "text/plain", strings.NewReader("hello"), 1<<20)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}
	if err := att.Attach(ctx, a.ID, mb.ID, bob.ID); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	snap, err := NewService(d).Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	if snap.Overview.TotalUsers != 2 {
		t.Errorf("TotalUsers = %d, want 2", snap.Overview.TotalUsers)
	}
	if snap.Overview.TotalMessages != 3 {
		t.Errorf("TotalMessages = %d, want 3", snap.Overview.TotalMessages)
	}
	if snap.Overview.DMConversations != 1 {
		t.Errorf("DMConversations = %d, want 1", snap.Overview.DMConversations)
	}
	if snap.Overview.TotalAttachments != 1 {
		t.Errorf("TotalAttachments = %d, want 1", snap.Overview.TotalAttachments)
	}
	if snap.Overview.TotalUploadBytes != 5 {
		t.Errorf("TotalUploadBytes = %d, want 5", snap.Overview.TotalUploadBytes)
	}

	if len(snap.PerUser) != 2 {
		t.Fatalf("PerUser len = %d, want 2", len(snap.PerUser))
	}
	// Username-sorted: alice first, bob second.
	if snap.PerUser[0].Username != "alice" || snap.PerUser[0].MessagesSent != 2 {
		t.Errorf("alice row wrong: %+v", snap.PerUser[0])
	}
	if snap.PerUser[0].LatestClientVersion != "desktop 0.18.1" {
		t.Errorf("alice latest version = %q, want %q", snap.PerUser[0].LatestClientVersion, "desktop 0.18.1")
	}
	if snap.PerUser[1].Username != "bob" || snap.PerUser[1].MessagesSent != 1 || snap.PerUser[1].AttachmentsUploaded != 1 || snap.PerUser[1].BytesUploaded != 5 {
		t.Errorf("bob row wrong: %+v", snap.PerUser[1])
	}
	if snap.PerUser[1].LatestClientVersion != "" {
		t.Errorf("bob should have no client version, got %q", snap.PerUser[1].LatestClientVersion)
	}
}

package messages

import (
	"context"
	"testing"
)

func TestMarkConversationRead_InsertsAndUpdates(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)

	// Insert a couple of messages so we have real IDs.
	m1, err := s.svc.Send(ctx, convID, alice.ID, "one")
	if err != nil {
		t.Fatalf("Send 1: %v", err)
	}
	m2, err := s.svc.Send(ctx, convID, alice.ID, "two")
	if err != nil {
		t.Fatalf("Send 2: %v", err)
	}

	// First mark: row didn't exist → changed=true.
	changed, err := s.svc.MarkConversationRead(ctx, convID, alice.ID, m1.ID)
	if err != nil {
		t.Fatalf("Mark 1: %v", err)
	}
	if !changed {
		t.Errorf("expected first mark to report changed=true")
	}

	// Move forward: changed=true.
	changed, err = s.svc.MarkConversationRead(ctx, convID, alice.ID, m2.ID)
	if err != nil {
		t.Fatalf("Mark 2: %v", err)
	}
	if !changed {
		t.Errorf("expected forward move to report changed=true")
	}

	// Re-mark the same (or earlier) — no-op.
	changed, err = s.svc.MarkConversationRead(ctx, convID, alice.ID, m2.ID)
	if err != nil {
		t.Fatalf("Mark same: %v", err)
	}
	if changed {
		t.Errorf("expected re-mark same to report changed=false")
	}
	changed, err = s.svc.MarkConversationRead(ctx, convID, alice.ID, m1.ID)
	if err != nil {
		t.Fatalf("Mark backward: %v", err)
	}
	if changed {
		t.Errorf("expected backward mark to report changed=false")
	}

	// And the stored value is still m2.
	reads, err := s.svc.ListReadsForConversation(ctx, convID)
	if err != nil {
		t.Fatalf("ListReadsForConversation: %v", err)
	}
	if len(reads) != 1 || reads[0].UserID != alice.ID || reads[0].LastReadMessageID != m2.ID {
		t.Errorf("unexpected reads: %+v", reads)
	}
}

func TestMarkConversationRead_ZeroIsNoop(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	convID, alice, _ := s.seedDM(t)

	changed, err := s.svc.MarkConversationRead(ctx, convID, alice.ID, 0)
	if err != nil {
		t.Fatalf("MarkConversationRead: %v", err)
	}
	if changed {
		t.Errorf("expected zero ID to report changed=false")
	}
	reads, err := s.svc.ListReadsForConversation(ctx, convID)
	if err != nil {
		t.Fatalf("ListReadsForConversation: %v", err)
	}
	if len(reads) != 0 {
		t.Errorf("expected no rows after zero-id mark, got %d", len(reads))
	}
}

func TestListReadsForUser_OnlyMemberConvs(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	convA, alice, bob := s.seedDM(t)

	// Seed a second conv that alice is NOT a member of.
	carol, err := s.auth.CreateUser(ctx, "carol", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser carol: %v", err)
	}
	convB, err := s.convs.FindOrCreateDM(ctx, bob.ID, carol.ID)
	if err != nil {
		t.Fatalf("seed conv B: %v", err)
	}

	// Send messages + mark reads in both convs from the participants
	// who belong there.
	mA, _ := s.svc.Send(ctx, convA, alice.ID, "in A")
	mB, _ := s.svc.Send(ctx, convB.ID, carol.ID, "in B")
	if _, err := s.svc.MarkConversationRead(ctx, convA, bob.ID, mA.ID); err != nil {
		t.Fatalf("mark in A: %v", err)
	}
	if _, err := s.svc.MarkConversationRead(ctx, convB.ID, carol.ID, mB.ID); err != nil {
		t.Fatalf("mark in B: %v", err)
	}

	// Alice should only see read states for convA (she's not in B).
	reads, err := s.svc.ListReadsForUser(ctx, alice.ID)
	if err != nil {
		t.Fatalf("ListReadsForUser: %v", err)
	}
	if len(reads) != 1 {
		t.Fatalf("expected 1 read state for alice, got %d", len(reads))
	}
	if reads[0].ConversationID != convA || reads[0].UserID != bob.ID {
		t.Errorf("unexpected: %+v", reads[0])
	}
}

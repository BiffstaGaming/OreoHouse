package messages

import (
	"context"
	"errors"
	"testing"
)

func TestToggleReaction_AddRemove(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	convID, alice, bob := s.seedDM(t)
	m1, err := s.svc.Send(ctx, convID, alice.ID, "hi")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	action, err := s.svc.ToggleReaction(ctx, m1.ID, bob.ID, "👍")
	if err != nil || action != ReactionAdded {
		t.Fatalf("first toggle: action=%s err=%v", action, err)
	}
	action, err = s.svc.ToggleReaction(ctx, m1.ID, bob.ID, "👍")
	if err != nil || action != ReactionRemoved {
		t.Fatalf("second toggle: action=%s err=%v", action, err)
	}

	// Different emoji is independent.
	if _, err := s.svc.ToggleReaction(ctx, m1.ID, bob.ID, "❤️"); err != nil {
		t.Fatalf("toggle heart: %v", err)
	}
	if _, err := s.svc.ToggleReaction(ctx, m1.ID, bob.ID, "🎉"); err != nil {
		t.Fatalf("toggle party: %v", err)
	}

	reactions, err := s.svc.ListReactionsForMessages(ctx, []int64{m1.ID})
	if err != nil {
		t.Fatalf("ListReactionsForMessages: %v", err)
	}
	if len(reactions) != 2 {
		t.Fatalf("expected 2 reactions, got %d", len(reactions))
	}
	emoji := map[string]bool{}
	for _, r := range reactions {
		emoji[r.Emoji] = true
	}
	if !emoji["❤️"] || !emoji["🎉"] {
		t.Errorf("unexpected emoji set: %+v", emoji)
	}
}

func TestToggleReaction_InvalidEmoji(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	convID, alice, bob := s.seedDM(t)
	m, _ := s.svc.Send(ctx, convID, alice.ID, "hi")
	cases := []string{"", string(make([]byte, MaxEmojiBytes+1))}
	for _, c := range cases {
		_, err := s.svc.ToggleReaction(ctx, m.ID, bob.ID, c)
		if !errors.Is(err, ErrEmojiTooLong) {
			t.Errorf("expected ErrEmojiTooLong for %d-byte input, got %v", len(c), err)
		}
	}
}

func TestListReactionsForMessages_Empty(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	got, err := s.svc.ListReactionsForMessages(ctx, nil)
	if err != nil {
		t.Fatalf("ListReactionsForMessages(nil): %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for empty input, got %+v", got)
	}
}

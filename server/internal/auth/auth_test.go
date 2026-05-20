package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
)

func newTestDB(t *testing.T) *sql.DB {
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
	return d
}

func newTestService(t *testing.T, ttl time.Duration) *Service {
	t.Helper()
	return NewService(newTestDB(t), ttl)
}

func TestValidateUsername(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"too short (1)", "a", false},
		{"min length (2)", "ab", true},
		{"max length (32)", strings.Repeat("a", 32), true},
		{"too long (33)", strings.Repeat("a", 33), false},
		{"alphanumeric+hyphen+underscore", "Alice_99-1", true},
		{"with space", "alice bob", false},
		{"with dot", "alice.bob", false},
		{"non-ASCII", "alíce", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateUsername(tc.in)
			if tc.ok && err != nil {
				t.Errorf("expected ok, got %v", err)
			}
			if !tc.ok && !errors.Is(err, ErrInvalidUsername) {
				t.Errorf("expected ErrInvalidUsername, got %v", err)
			}
		})
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("1234567"); !errors.Is(err, ErrPasswordTooShort) {
		t.Errorf("expected ErrPasswordTooShort for 7-char password, got %v", err)
	}
	if err := ValidatePassword("12345678"); err != nil {
		t.Errorf("expected ok for 8-char password, got %v", err)
	}
}

func TestCreateUser_AndAuthenticateRoundTrip(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if user.ID == 0 {
		t.Errorf("expected non-zero user ID")
	}
	if user.Username != "alice" {
		t.Errorf("expected username alice, got %q", user.Username)
	}

	got, err := svc.Authenticate(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if got.ID != user.ID {
		t.Errorf("expected ID %d, got %d", user.ID, got.ID)
	}
}

func TestCreateUser_DuplicateReturnsErrUserExists(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if _, err := svc.CreateUser(ctx, "alice", "hunter2hunter"); err != nil {
		t.Fatalf("first CreateUser: %v", err)
	}
	_, err := svc.CreateUser(ctx, "alice", "anothergoodpw")
	if !errors.Is(err, ErrUserExists) {
		t.Errorf("expected ErrUserExists, got %v", err)
	}
}

func TestCreateUser_UsernameCaseInsensitiveUnique(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if _, err := svc.CreateUser(ctx, "alice", "hunter2hunter"); err != nil {
		t.Fatalf("first CreateUser: %v", err)
	}
	_, err := svc.CreateUser(ctx, "Alice", "anothergoodpw")
	if !errors.Is(err, ErrUserExists) {
		t.Errorf("expected case-insensitive uniqueness, got %v", err)
	}
}

func TestCreateUser_ValidationFailures(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if _, err := svc.CreateUser(ctx, "x", "hunter2hunter"); !errors.Is(err, ErrInvalidUsername) {
		t.Errorf("expected ErrInvalidUsername, got %v", err)
	}
	if _, err := svc.CreateUser(ctx, "alice", "short"); !errors.Is(err, ErrPasswordTooShort) {
		t.Errorf("expected ErrPasswordTooShort, got %v", err)
	}
}

func TestAuthenticate_WrongPassword(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if _, err := svc.CreateUser(ctx, "alice", "hunter2hunter"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := svc.Authenticate(ctx, "alice", "wrongpwd1"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("expected ErrInvalidCredentials, got %v", err)
	}
}

func TestAuthenticate_UnknownUser(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if _, err := svc.Authenticate(ctx, "ghost", "hunter2hunter"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("expected ErrInvalidCredentials, got %v", err)
	}
}

func TestCreateSession_NoTTL(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if !sess.ExpiresAt.IsZero() {
		t.Errorf("expected zero ExpiresAt for TTL=0, got %v", sess.ExpiresAt)
	}
	if len(sess.Token) != 64 {
		t.Errorf("expected 64-char hex token, got len %d", len(sess.Token))
	}
}

func TestCreateSession_WithTTL(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, time.Hour)
	base := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return base }

	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if !sess.ExpiresAt.Equal(base.Add(time.Hour)) {
		t.Errorf("expected ExpiresAt=%v, got %v", base.Add(time.Hour), sess.ExpiresAt)
	}
}

func TestLookupSession_FindsValid(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	gotUser, gotSess, err := svc.LookupSession(ctx, sess.Token)
	if err != nil {
		t.Fatalf("LookupSession: %v", err)
	}
	if gotUser.ID != user.ID {
		t.Errorf("expected user.ID=%d, got %d", user.ID, gotUser.ID)
	}
	if gotSess.Token != sess.Token {
		t.Errorf("expected token match")
	}
}

func TestLookupSession_NotFound(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	_, _, err := svc.LookupSession(ctx, "no-such-token")
	if !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected ErrSessionNotFound, got %v", err)
	}
}

func TestLookupSession_Expired(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, time.Hour)
	base := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return base }

	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Jump past expiry.
	svc.now = func() time.Time { return base.Add(2 * time.Hour) }

	_, _, err = svc.LookupSession(ctx, sess.Token)
	if !errors.Is(err, ErrSessionExpired) {
		t.Errorf("expected ErrSessionExpired, got %v", err)
	}
}

func TestDeleteSession_Idempotent(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.DeleteSession(ctx, sess.Token); err != nil {
		t.Fatalf("first delete: %v", err)
	}
	if err := svc.DeleteSession(ctx, sess.Token); err != nil {
		t.Fatalf("second delete (should be idempotent): %v", err)
	}
	if _, _, err := svc.LookupSession(ctx, sess.Token); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected ErrSessionNotFound after delete, got %v", err)
	}
}

func TestListUsers_OrderedByID(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	names := []string{"alice", "bob", "carol"}
	for _, name := range names {
		if _, err := svc.CreateUser(ctx, name, "hunter2hunter"); err != nil {
			t.Fatalf("CreateUser %s: %v", name, err)
		}
	}
	users, err := svc.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) != len(names) {
		t.Fatalf("expected %d users, got %d", len(names), len(users))
	}
	for i, u := range users {
		if u.Username != names[i] {
			t.Errorf("user[%d]: expected %s, got %s", i, names[i], u.Username)
		}
	}
}

func TestNewSessionToken_Unique(t *testing.T) {
	seen := make(map[string]bool, 100)
	for i := 0; i < 100; i++ {
		tok, err := newSessionToken()
		if err != nil {
			t.Fatalf("newSessionToken: %v", err)
		}
		if len(tok) != 64 {
			t.Errorf("expected 64-char token, got %d", len(tok))
		}
		if seen[tok] {
			t.Errorf("duplicate token: %q", tok)
		}
		seen[tok] = true
	}
}

func TestSessionExpired(t *testing.T) {
	base := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		exp     time.Time
		now     time.Time
		expired bool
	}{
		{"never expires", time.Time{}, base, false},
		{"before expiry", base.Add(time.Hour), base, false},
		{"at expiry", base, base, true},
		{"past expiry", base.Add(-time.Hour), base, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := Session{ExpiresAt: tc.exp}
			if got := s.Expired(tc.now); got != tc.expired {
				t.Errorf("Expired() = %v, want %v", got, tc.expired)
			}
		})
	}
}

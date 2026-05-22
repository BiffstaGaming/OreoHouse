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

// SetSessionClientVersion is what the WS handler calls on every
// connect so existing-NULL sessions get backfilled with whatever
// client identified at connect time.
func TestSetSessionClientVersion_UpdatesExistingRow(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// Existing session created without a version (the legacy path).
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Empty string is explicitly a no-op so we don't clobber a
	// previously-set value with a missing header.
	if err := svc.SetSessionClientVersion(ctx, sess.Token, ""); err != nil {
		t.Fatalf("empty: %v", err)
	}
	var got sql.NullString
	if err := svc.db.QueryRowContext(ctx,
		"SELECT client_version FROM sessions WHERE token = ?", sess.Token,
	).Scan(&got); err != nil {
		t.Fatalf("query: %v", err)
	}
	if got.Valid {
		t.Errorf("empty arg shouldn't change column; got %q", got.String)
	}
	// Real value stamps the column.
	if err := svc.SetSessionClientVersion(ctx, sess.Token, "desktop 0.20.0"); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	if err := svc.db.QueryRowContext(ctx,
		"SELECT client_version FROM sessions WHERE token = ?", sess.Token,
	).Scan(&got); err != nil {
		t.Fatalf("query2: %v", err)
	}
	if !got.Valid || got.String != "desktop 0.20.0" {
		t.Errorf("expected desktop 0.20.0, got %q", got.String)
	}
	// Long values get truncated to 64 chars to defend against
	// runaway UA-style strings.
	huge := strings.Repeat("x", 200)
	if err := svc.SetSessionClientVersion(ctx, sess.Token, huge); err != nil {
		t.Fatalf("huge: %v", err)
	}
	if err := svc.db.QueryRowContext(ctx,
		"SELECT client_version FROM sessions WHERE token = ?", sess.Token,
	).Scan(&got); err != nil {
		t.Fatalf("query3: %v", err)
	}
	if len(got.String) != 64 {
		t.Errorf("expected truncation to 64 chars, got len %d", len(got.String))
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

func TestSetDisplayName_RoundTrip(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	u, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if u.DisplayName != "" {
		t.Errorf("expected empty display_name on create, got %q", u.DisplayName)
	}
	if err := svc.SetDisplayName(ctx, u.ID, "Alice 🌸"); err != nil {
		t.Fatalf("SetDisplayName: %v", err)
	}
	got, err := svc.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.DisplayName != "Alice 🌸" {
		t.Errorf("expected display_name 'Alice 🌸', got %q", got.DisplayName)
	}
	// Empty clears.
	if err := svc.SetDisplayName(ctx, u.ID, ""); err != nil {
		t.Fatalf("clear display_name: %v", err)
	}
	got, _ = svc.GetUserByID(ctx, u.ID)
	if got.DisplayName != "" {
		t.Errorf("expected cleared display_name, got %q", got.DisplayName)
	}
}

func TestSetDisplayName_TooLong(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	u, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	long := strings.Repeat("a", MaxDisplayNameLength+1)
	if err := svc.SetDisplayName(ctx, u.ID, long); !errors.Is(err, ErrDisplayNameTooLong) {
		t.Errorf("expected ErrDisplayNameTooLong, got %v", err)
	}
}

func TestSetAvatarAttachmentID_RoundTrip(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	u, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// Without a real attachment, SET to a hypothetical id should still
	// succeed at the auth layer (the FK enforces the constraint —
	// SQLite without PRAGMA foreign_keys=ON tolerates dangling refs).
	// For this test we just verify the column round-trips.
	if err := svc.SetAvatarAttachmentID(ctx, u.ID, 0); err != nil {
		t.Fatalf("clear avatar (already null): %v", err)
	}
	got, _ := svc.GetUserByID(ctx, u.ID)
	if got.AvatarAttachmentID != 0 {
		t.Errorf("expected avatar 0, got %d", got.AvatarAttachmentID)
	}
}

func TestCreateUser_DefaultsToNonAdmin(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	u, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if u.IsAdmin {
		t.Errorf("expected freshly-created user to default to non-admin")
	}
	// Authenticate should round-trip is_admin=false too.
	got, err := svc.Authenticate(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if got.IsAdmin {
		t.Errorf("Authenticate: expected IsAdmin=false")
	}
}

func TestSetAdmin_PromoteAndDemote(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	a, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser alice: %v", err)
	}
	b, err := svc.CreateUser(ctx, "bob", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser bob: %v", err)
	}

	if err := svc.SetAdmin(ctx, a.ID, true); err != nil {
		t.Fatalf("promote alice: %v", err)
	}
	if err := svc.SetAdmin(ctx, b.ID, true); err != nil {
		t.Fatalf("promote bob: %v", err)
	}
	if n, err := svc.CountAdmins(ctx); err != nil || n != 2 {
		t.Fatalf("CountAdmins after two promotes: n=%d err=%v", n, err)
	}

	if err := svc.SetAdmin(ctx, b.ID, false); err != nil {
		t.Fatalf("demote bob: %v", err)
	}
	if n, err := svc.CountAdmins(ctx); err != nil || n != 1 {
		t.Fatalf("CountAdmins after one demote: n=%d err=%v", n, err)
	}

	// Refuse to demote the last admin.
	if err := svc.SetAdmin(ctx, a.ID, false); !errors.Is(err, ErrLastAdmin) {
		t.Errorf("expected ErrLastAdmin demoting last admin, got %v", err)
	}
	// And alice is still an admin afterwards.
	got, err := svc.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if !got.IsAdmin {
		t.Errorf("expected alice still admin after failed demote")
	}
}

func TestSetAdmin_UnknownUser(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if err := svc.SetAdmin(ctx, 999, true); !errors.Is(err, ErrUserNotFound) {
		t.Errorf("expected ErrUserNotFound for unknown id, got %v", err)
	}
}

func TestSetPassword_RoundTrip(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	u, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := svc.SetPassword(ctx, u.ID, "brandnewpw!"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	// Old password no longer works.
	if _, err := svc.Authenticate(ctx, "alice", "hunter2hunter"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("expected ErrInvalidCredentials with old password, got %v", err)
	}
	// New password does.
	if _, err := svc.Authenticate(ctx, "alice", "brandnewpw!"); err != nil {
		t.Errorf("Authenticate with new password: %v", err)
	}
}

func TestSetPassword_ValidationAndUnknownUser(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	u, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := svc.SetPassword(ctx, u.ID, "short"); !errors.Is(err, ErrPasswordTooShort) {
		t.Errorf("expected ErrPasswordTooShort, got %v", err)
	}
	if err := svc.SetPassword(ctx, 999, "longenough"); !errors.Is(err, ErrUserNotFound) {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestGetUserByUsername(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	created, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	got, err := svc.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if got.ID != created.ID {
		t.Errorf("expected id %d, got %d", created.ID, got.ID)
	}
	if _, err := svc.GetUserByUsername(ctx, "ghost"); !errors.Is(err, ErrUserNotFound) {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestListUsersDetail(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, 0)
	if _, err := svc.CreateUser(ctx, "alice", "hunter2hunter"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	bob, err := svc.CreateUser(ctx, "bob", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	now := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)
	if err := svc.UpdateLastSeen(ctx, bob.ID, now); err != nil {
		t.Fatalf("UpdateLastSeen: %v", err)
	}
	if err := svc.SetAdmin(ctx, bob.ID, true); err != nil {
		t.Fatalf("SetAdmin: %v", err)
	}
	out, err := svc.ListUsersDetail(ctx)
	if err != nil {
		t.Fatalf("ListUsersDetail: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(out))
	}
	if !out[0].LastSeenAt.IsZero() {
		t.Errorf("expected alice LastSeenAt zero, got %v", out[0].LastSeenAt)
	}
	if out[0].IsAdmin {
		t.Errorf("expected alice not admin")
	}
	if out[1].Username != "bob" || !out[1].IsAdmin {
		t.Errorf("expected bob admin, got %+v", out[1])
	}
	if !out[1].LastSeenAt.Equal(now) {
		t.Errorf("expected bob LastSeenAt=%v, got %v", now, out[1].LastSeenAt)
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

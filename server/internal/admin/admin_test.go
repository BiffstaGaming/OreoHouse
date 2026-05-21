package admin

import (
	"bytes"
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
)

func newTestService(t *testing.T) *auth.Service {
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
	return auth.NewService(d, 0)
}

func TestRunUser_AddViaPasswordStdin(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	stdin := strings.NewReader("hunter2hunter\n")
	var stdout bytes.Buffer

	err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc, stdin, &stdout)
	if err != nil {
		t.Fatalf("RunUser: %v", err)
	}
	if !strings.Contains(stdout.String(), `User "alice" created`) {
		t.Errorf("expected success message, got %q", stdout.String())
	}

	// And the user is actually in the database.
	if _, err := svc.Authenticate(ctx, "alice", "hunter2hunter"); err != nil {
		t.Errorf("expected to authenticate alice, got %v", err)
	}
}

func TestRunUser_AddMissingUsername(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	stdin := strings.NewReader("hunter2hunter\n")
	var stdout bytes.Buffer

	err := RunUser(ctx, []string{"add", "--password-stdin"}, svc, stdin, &stdout)
	if err == nil || !strings.Contains(err.Error(), "--username is required") {
		t.Errorf("expected --username required error, got %v", err)
	}
}

func TestRunUser_AddDuplicateUsername(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	stdin1 := strings.NewReader("hunter2hunter\n")
	var stdout1 bytes.Buffer
	if err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc, stdin1, &stdout1); err != nil {
		t.Fatalf("first add: %v", err)
	}

	stdin2 := strings.NewReader("hunter2hunter\n")
	var stdout2 bytes.Buffer
	err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc, stdin2, &stdout2)
	if !errors.Is(err, auth.ErrUserExists) {
		t.Errorf("expected ErrUserExists, got %v", err)
	}
}

func TestRunUser_AddInvalidUsername(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	stdin := strings.NewReader("hunter2hunter\n")
	var stdout bytes.Buffer

	err := RunUser(ctx, []string{"add", "--username", "a", "--password-stdin"}, svc, stdin, &stdout)
	if !errors.Is(err, auth.ErrInvalidUsername) {
		t.Errorf("expected ErrInvalidUsername, got %v", err)
	}
}

func TestRunUser_AddShortPassword(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	stdin := strings.NewReader("short\n")
	var stdout bytes.Buffer

	err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc, stdin, &stdout)
	if !errors.Is(err, auth.ErrPasswordTooShort) {
		t.Errorf("expected ErrPasswordTooShort, got %v", err)
	}
}

func TestRunUser_AddStripsUTF8BOM(t *testing.T) {
	// PowerShell 5.1 prepends a UTF-8 BOM when piping strings to native
	// commands. The CLI must strip it so the password the user typed is
	// what gets hashed.
	ctx := context.Background()
	svc := newTestService(t)
	stdin := strings.NewReader(string([]byte{0xEF, 0xBB, 0xBF}) + "hunter2hunter\n")
	var stdout bytes.Buffer

	err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc, stdin, &stdout)
	if err != nil {
		t.Fatalf("RunUser: %v", err)
	}
	if _, err := svc.Authenticate(ctx, "alice", "hunter2hunter"); err != nil {
		t.Errorf("expected to authenticate alice with BOM-free password, got %v", err)
	}
}

func TestRunUser_AddEmptyStdin(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	stdin := strings.NewReader("")
	var stdout bytes.Buffer

	err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc, stdin, &stdout)
	if err == nil || !strings.Contains(err.Error(), "expected a password on stdin") {
		t.Errorf("expected stdin-empty error, got %v", err)
	}
}

func TestRunUser_AddPromotesFirstUser(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	// First add → auto-promoted.
	var out1 bytes.Buffer
	if err := RunUser(ctx, []string{"add", "--username", "alice", "--password-stdin"}, svc,
		strings.NewReader("hunter2hunter\n"), &out1); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if !strings.Contains(out1.String(), "promoted to admin") {
		t.Errorf("expected first-add output to mention promotion, got %q", out1.String())
	}
	alice, err := svc.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername alice: %v", err)
	}
	if !alice.IsAdmin {
		t.Errorf("expected alice IsAdmin=true after bootstrap")
	}

	// Second add → not promoted.
	var out2 bytes.Buffer
	if err := RunUser(ctx, []string{"add", "--username", "bob", "--password-stdin"}, svc,
		strings.NewReader("hunter2hunter\n"), &out2); err != nil {
		t.Fatalf("second add: %v", err)
	}
	if strings.Contains(out2.String(), "promoted to admin") {
		t.Errorf("expected second-add output NOT to mention promotion, got %q", out2.String())
	}
	bob, err := svc.GetUserByUsername(ctx, "bob")
	if err != nil {
		t.Fatalf("GetUserByUsername bob: %v", err)
	}
	if bob.IsAdmin {
		t.Errorf("expected bob IsAdmin=false")
	}
}

func TestRunUser_PromoteAndDemote(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	// Seed alice (admin via bootstrap) and bob (non-admin).
	for _, name := range []string{"alice", "bob"} {
		if err := RunUser(ctx, []string{"add", "--username", name, "--password-stdin"}, svc,
			strings.NewReader("hunter2hunter\n"), &bytes.Buffer{}); err != nil {
			t.Fatalf("seeding %s: %v", name, err)
		}
	}

	// Promote bob.
	var out bytes.Buffer
	if err := RunUser(ctx, []string{"promote", "--username", "bob"}, svc, strings.NewReader(""), &out); err != nil {
		t.Fatalf("promote bob: %v", err)
	}
	if !strings.Contains(out.String(), `"bob" promoted to admin`) {
		t.Errorf("expected promote message, got %q", out.String())
	}
	bob, err := svc.GetUserByUsername(ctx, "bob")
	if err != nil || !bob.IsAdmin {
		t.Errorf("expected bob admin after promote, got admin=%v err=%v", bob.IsAdmin, err)
	}

	// Re-promoting is a no-op message, not an error.
	var out2 bytes.Buffer
	if err := RunUser(ctx, []string{"promote", "--username", "bob"}, svc, strings.NewReader(""), &out2); err != nil {
		t.Errorf("re-promote should be no-op success, got %v", err)
	}
	if !strings.Contains(out2.String(), "already an admin") {
		t.Errorf("expected idempotent message, got %q", out2.String())
	}

	// Demote alice → succeeds (bob is now also admin).
	var out3 bytes.Buffer
	if err := RunUser(ctx, []string{"demote", "--username", "alice"}, svc, strings.NewReader(""), &out3); err != nil {
		t.Fatalf("demote alice: %v", err)
	}
	if !strings.Contains(out3.String(), `"alice" demoted from admin`) {
		t.Errorf("expected demote message, got %q", out3.String())
	}

	// Demote bob → refused (last admin).
	if err := RunUser(ctx, []string{"demote", "--username", "bob"}, svc, strings.NewReader(""), &bytes.Buffer{}); !errors.Is(err, auth.ErrLastAdmin) {
		t.Errorf("expected ErrLastAdmin, got %v", err)
	}
}

func TestRunUser_PromoteUnknownUser(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if err := RunUser(ctx, []string{"promote", "--username", "ghost"}, svc, strings.NewReader(""), &bytes.Buffer{}); !errors.Is(err, auth.ErrUserNotFound) {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestRunUser_PromoteMissingUsername(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if err := RunUser(ctx, []string{"promote"}, svc, strings.NewReader(""), &bytes.Buffer{}); err == nil ||
		!strings.Contains(err.Error(), "--username is required") {
		t.Errorf("expected --username required error, got %v", err)
	}
}

func TestRunUser_List(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	for _, name := range []string{"alice", "bob"} {
		stdin := strings.NewReader("hunter2hunter\n")
		var sink bytes.Buffer
		if err := RunUser(ctx, []string{"add", "--username", name, "--password-stdin"}, svc, stdin, &sink); err != nil {
			t.Fatalf("seeding %s: %v", name, err)
		}
	}

	var stdout bytes.Buffer
	if err := RunUser(ctx, []string{"list"}, svc, strings.NewReader(""), &stdout); err != nil {
		t.Fatalf("list: %v", err)
	}
	out := stdout.String()
	for _, want := range []string{"ID", "USERNAME", "ADMIN", "CREATED", "alice", "bob"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected output to contain %q, got %q", want, out)
		}
	}
	// alice is first → bootstrapped to admin → "yes". bob isn't → "-".
	// Tabwriter pads columns variably; match on the line shape instead.
	if !regexp.MustCompile(`(?m)^\s*1\s+alice\s+yes\b`).MatchString(out) {
		t.Errorf("expected alice line with admin=yes, got %q", out)
	}
	if !regexp.MustCompile(`(?m)^\s*2\s+bob\s+-\s`).MatchString(out) {
		t.Errorf("expected bob line with admin=-, got %q", out)
	}
}

func TestRunUser_NoArgs(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	err := RunUser(ctx, nil, svc, strings.NewReader(""), &bytes.Buffer{})
	if err == nil {
		t.Errorf("expected usage error with no args")
	}
}

func TestRunUser_UnknownSubcommand(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	err := RunUser(ctx, []string{"delete"}, svc, strings.NewReader(""), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "unknown user subcommand") {
		t.Errorf("expected unknown subcommand error, got %v", err)
	}
}

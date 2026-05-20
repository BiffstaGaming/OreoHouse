package admin

import (
	"bytes"
	"context"
	"errors"
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
	for _, want := range []string{"ID", "USERNAME", "CREATED", "alice", "bob"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected output to contain %q, got %q", want, out)
		}
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

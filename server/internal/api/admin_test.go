package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
	"github.com/BiffstaGaming/OreoHouse/server/internal/stats"
)

type adminStack struct {
	svc *auth.Service
	srv *httptest.Server
}

func newAdminStack(t *testing.T) *adminStack {
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

	svc := auth.NewService(d, 0)
	r := chi.NewRouter()
	NewAdminHandler(svc, stats.NewService(d)).Mount(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &adminStack{svc: svc, srv: srv}
}

// seedUserWithToken creates a user, optionally promotes them, and
// returns the user + a fresh session token.
func (s *adminStack) seedUserWithToken(t *testing.T, username string, isAdmin bool) (auth.User, string) {
	t.Helper()
	ctx := context.Background()
	u, err := s.svc.CreateUser(ctx, username, "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	if isAdmin {
		if err := s.svc.SetAdmin(ctx, u.ID, true); err != nil {
			t.Fatalf("SetAdmin %s: %v", username, err)
		}
		u.IsAdmin = true
	}
	sess, err := s.svc.CreateSession(ctx, u.ID)
	if err != nil {
		t.Fatalf("CreateSession %s: %v", username, err)
	}
	return u, sess.Token
}

func (s *adminStack) do(t *testing.T, method, path, token, body string) *http.Response {
	t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest(method, s.srv.URL+path, reader)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

// --- admin gate -------------------------------------------------------

func TestAdmin_MissingAuth(t *testing.T) {
	s := newAdminStack(t)
	resp := s.do(t, http.MethodGet, "/api/admin/users", "", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAdmin_NonAdminForbidden(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "bob", false)
	resp := s.do(t, http.MethodGet, "/api/admin/users", token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403, got %d", resp.StatusCode)
	}
	var body proto.ErrorResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != "admin required" {
		t.Errorf("expected 'admin required', got %q", body.Error)
	}
}

// --- listUsers --------------------------------------------------------

func TestAdmin_ListUsers(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)
	// Seed a second user with a known last_seen_at.
	bob, _ := s.seedUserWithToken(t, "bob", false)
	now := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)
	if err := s.svc.UpdateLastSeen(context.Background(), bob.ID, now); err != nil {
		t.Fatalf("UpdateLastSeen: %v", err)
	}

	resp := s.do(t, http.MethodGet, "/api/admin/users", token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var got proto.ListAdminUsersResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(got.Users))
	}
	if got.Users[0].Username != "admin" || !got.Users[0].IsAdmin {
		t.Errorf("expected admin first and admin, got %+v", got.Users[0])
	}
	if got.Users[0].LastSeenAt != "" {
		t.Errorf("expected admin last_seen_at empty, got %q", got.Users[0].LastSeenAt)
	}
	if got.Users[1].Username != "bob" || got.Users[1].IsAdmin {
		t.Errorf("expected bob second and non-admin, got %+v", got.Users[1])
	}
	if got.Users[1].LastSeenAt == "" {
		t.Errorf("expected bob last_seen_at non-empty")
	}
}

// --- createUser -------------------------------------------------------

func TestAdmin_CreateUser_Success(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)

	resp := s.do(t, http.MethodPost, "/api/admin/users", token,
		`{"username":"carol","password":"hunter2hunter"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}
	var got struct {
		User proto.AdminUserView `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.User.Username != "carol" || got.User.IsAdmin {
		t.Errorf("expected carol non-admin, got %+v", got.User)
	}

	// Verify the new user can log in.
	if _, err := s.svc.Authenticate(context.Background(), "carol", "hunter2hunter"); err != nil {
		t.Errorf("Authenticate carol: %v", err)
	}
}

func TestAdmin_CreateUser_DuplicateUsername(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)
	s.seedUserWithToken(t, "bob", false)

	resp := s.do(t, http.MethodPost, "/api/admin/users", token,
		`{"username":"bob","password":"hunter2hunter"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("expected 409, got %d", resp.StatusCode)
	}
}

func TestAdmin_CreateUser_Validation(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)

	cases := []struct {
		name, body string
		want       int
	}{
		{"invalid JSON", `not json`, http.StatusBadRequest},
		{"short password", `{"username":"carol","password":"short"}`, http.StatusBadRequest},
		{"bad username", `{"username":"x","password":"hunter2hunter"}`, http.StatusBadRequest},
		{"unknown field", `{"username":"carol","password":"hunter2hunter","extra":1}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := s.do(t, http.MethodPost, "/api/admin/users", token, tc.body)
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Errorf("expected %d, got %d", tc.want, resp.StatusCode)
			}
		})
	}
}

// --- setPassword ------------------------------------------------------

func TestAdmin_SetPassword_Success(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)
	bob, _ := s.seedUserWithToken(t, "bob", false)

	resp := s.do(t, http.MethodPut,
		fmt.Sprintf("/api/admin/users/%d/password", bob.ID), token,
		`{"password":"freshpassword"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}
	if _, err := s.svc.Authenticate(context.Background(), "bob", "freshpassword"); err != nil {
		t.Errorf("Authenticate bob with new password: %v", err)
	}
	if _, err := s.svc.Authenticate(context.Background(), "bob", "hunter2hunter"); err == nil {
		t.Errorf("expected old password rejected")
	}
}

func TestAdmin_SetPassword_TooShort(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)
	bob, _ := s.seedUserWithToken(t, "bob", false)

	resp := s.do(t, http.MethodPut,
		fmt.Sprintf("/api/admin/users/%d/password", bob.ID), token,
		`{"password":"x"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestAdmin_SetPassword_UnknownUser(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)

	resp := s.do(t, http.MethodPut, "/api/admin/users/9999/password", token,
		`{"password":"freshpassword"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestAdmin_SetPassword_InvalidID(t *testing.T) {
	s := newAdminStack(t)
	_, token := s.seedUserWithToken(t, "admin", true)

	resp := s.do(t, http.MethodPut, "/api/admin/users/abc/password", token,
		`{"password":"freshpassword"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

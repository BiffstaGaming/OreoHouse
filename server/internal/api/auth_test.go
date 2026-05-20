package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

func newTestStack(t *testing.T) (*AuthHandler, *auth.Service, *httptest.Server) {
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
	h := NewAuthHandler(svc)

	r := chi.NewRouter()
	h.Mount(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return h, svc, srv
}

func TestLogin_Success(t *testing.T) {
	_, svc, srv := newTestStack(t)
	if _, err := svc.CreateUser(context.Background(), "alice", "hunter2hunter"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	body := `{"username":"alice","password":"hunter2hunter"}`
	resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/auth/login: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var got proto.LoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(got.Token) != 64 {
		t.Errorf("expected 64-char token, got len %d", len(got.Token))
	}
	if got.ExpiresAt != "" {
		t.Errorf("expected no expires_at when TTL=0, got %q", got.ExpiresAt)
	}
	if got.User.Username != "alice" {
		t.Errorf("expected username alice, got %q", got.User.Username)
	}
	if got.User.ID == 0 {
		t.Errorf("expected non-zero user ID")
	}
}

func TestLogin_BadCredentials(t *testing.T) {
	_, svc, srv := newTestStack(t)
	if _, err := svc.CreateUser(context.Background(), "alice", "hunter2hunter"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	body := `{"username":"alice","password":"wrongpwd1"}`
	resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestLogin_UnknownUserLooksLikeBadPassword(t *testing.T) {
	_, _, srv := newTestStack(t)
	body := `{"username":"ghost","password":"hunter2hunter"}`
	resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 (not 404) for unknown user, got %d", resp.StatusCode)
	}
}

func TestLogin_MissingFields(t *testing.T) {
	_, _, srv := newTestStack(t)
	cases := []string{
		`{"username":"alice"}`,
		`{"password":"hunter2hunter"}`,
		`{}`,
	}
	for _, body := range cases {
		resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST %s: %v", body, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("body %s: expected 400, got %d", body, resp.StatusCode)
		}
	}
}

func TestLogin_MalformedJSON(t *testing.T) {
	_, _, srv := newTestStack(t)
	resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(`{bad`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestLogin_RejectsUnknownFields(t *testing.T) {
	_, _, srv := newTestStack(t)
	body := `{"username":"alice","password":"x","extra":"nope"}`
	resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for unknown field, got %d", resp.StatusCode)
	}
}

func TestLogout_DeletesSession(t *testing.T) {
	_, svc, srv := newTestStack(t)
	ctx := context.Background()
	user, err := svc.CreateUser(ctx, "alice", "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := svc.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+sess.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204, got %d", resp.StatusCode)
	}

	// The session must be gone.
	if _, _, err := svc.LookupSession(ctx, sess.Token); err == nil {
		t.Errorf("expected session to be deleted, but LookupSession succeeded")
	}
}

func TestLogout_Idempotent(t *testing.T) {
	_, _, srv := newTestStack(t)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer some-bogus-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204 for unknown token, got %d", resp.StatusCode)
	}
}

func TestLogout_MissingAuthHeader(t *testing.T) {
	_, _, srv := newTestStack(t)
	resp, err := http.Post(srv.URL+"/api/auth/logout", "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestLogin_IncludesExpiresAtWhenTTLSet(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer d.Close()
	if err := db.Migrate(ctx, d, server.Migrations()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	svc := auth.NewService(d, 24*60*60*1_000_000_000) // 1 day in ns
	if _, err := svc.CreateUser(ctx, "alice", "hunter2hunter"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	r := chi.NewRouter()
	NewAuthHandler(svc).Mount(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	body := `{"username":"alice","password":"hunter2hunter"}`
	resp, err := http.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()

	var got proto.LoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ExpiresAt == "" {
		t.Errorf("expected expires_at to be set with TTL>0")
	}
}

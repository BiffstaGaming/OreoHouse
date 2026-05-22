package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

type profileStack struct {
	auth        *auth.Service
	attachments *attachments.Service
	srv         *httptest.Server
	broadcasts  [][]byte
}

func newProfileStack(t *testing.T) *profileStack {
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

	uploadsDir := filepath.Join(t.TempDir(), "uploads")
	att, err := attachments.NewService(d, uploadsDir)
	if err != nil {
		t.Fatalf("attachments.NewService: %v", err)
	}
	stack := &profileStack{
		auth:        auth.NewService(d, 0),
		attachments: att,
	}
	stack.srv = httptest.NewServer(func() http.Handler {
		r := chi.NewRouter()
		NewProfileHandler(stack.auth, stack.attachments, broadcasterFn(func(b []byte) {
			stack.broadcasts = append(stack.broadcasts, b)
		})).Mount(r)
		return r
	}())
	t.Cleanup(stack.srv.Close)
	return stack
}

type broadcasterFn func([]byte)

func (b broadcasterFn) Broadcast(msg []byte) { b(msg) }

func (s *profileStack) seedUser(t *testing.T, name string) (auth.User, string) {
	t.Helper()
	ctx := context.Background()
	u, err := s.auth.CreateUser(ctx, name, "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := s.auth.CreateSession(ctx, u.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return u, sess.Token
}

func (s *profileStack) do(t *testing.T, method, path, token, ct string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, s.srv.URL+path, body)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

func TestProfile_SetDisplayName(t *testing.T) {
	s := newProfileStack(t)
	_, token := s.seedUser(t, "alice")

	resp := s.do(t, http.MethodPut, "/api/me/profile", token, "application/json",
		strings.NewReader(`{"display_name":"Alice 🌸"}`))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var got proto.UserInfo
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.DisplayName != "Alice 🌸" {
		t.Errorf("expected display_name 'Alice 🌸', got %q", got.DisplayName)
	}
	// Broadcast fired.
	if len(s.broadcasts) != 1 {
		t.Errorf("expected 1 broadcast, got %d", len(s.broadcasts))
	}
}

func TestProfile_ListUsers(t *testing.T) {
	s := newProfileStack(t)
	_, aliceToken := s.seedUser(t, "alice")
	s.seedUser(t, "bob")
	s.seedUser(t, "carol")

	resp := s.do(t, http.MethodGet, "/api/users", aliceToken, "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var got proto.ListUsersResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Users) != 3 {
		t.Fatalf("expected 3 users, got %d", len(got.Users))
	}
	// Should include the caller too — clients filter by id, server
	// doesn't pre-filter so callers stay simple.
	names := map[string]bool{}
	for _, u := range got.Users {
		names[u.Username] = true
	}
	for _, want := range []string{"alice", "bob", "carol"} {
		if !names[want] {
			t.Errorf("expected %q in list, missing", want)
		}
	}
}

func TestProfile_ListUsers_RequiresAuth(t *testing.T) {
	s := newProfileStack(t)
	resp := s.do(t, http.MethodGet, "/api/users", "", "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestProfile_SetDisplayName_TooLong(t *testing.T) {
	s := newProfileStack(t)
	_, token := s.seedUser(t, "alice")
	long := strings.Repeat("a", auth.MaxDisplayNameLength+1)
	body := `{"display_name":"` + long + `"}`
	resp := s.do(t, http.MethodPut, "/api/me/profile", token, "application/json",
		strings.NewReader(body))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestProfile_UploadAndGetAvatar(t *testing.T) {
	s := newProfileStack(t)
	alice, aliceToken := s.seedUser(t, "alice")
	_, bobToken := s.seedUser(t, "bob")

	// 1x1 PNG (smallest valid).
	pngBytes := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
		0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
		0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
		0x42, 0x60, 0x82,
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="file"; filename="avatar.png"`},
		"Content-Type":        {"image/png"},
	})
	_, _ = part.Write(pngBytes)
	_ = mw.Close()

	// Upload as alice.
	resp := s.do(t, http.MethodPost, "/api/me/avatar", aliceToken, mw.FormDataContentType(), &body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		bb, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d body=%s", resp.StatusCode, string(bb))
	}
	var view proto.UserInfo
	if err := json.NewDecoder(resp.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !view.HasAvatar {
		t.Errorf("expected HasAvatar=true after upload")
	}

	// Bob can fetch alice's avatar (any authenticated user).
	resp2 := s.do(t, http.MethodGet, "/api/users/"+itoaInt64(alice.ID)+"/avatar", bobToken, "", nil)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("expected 200 for avatar fetch, got %d", resp2.StatusCode)
	}
	if resp2.Header.Get("Content-Type") != "image/png" {
		t.Errorf("expected image/png, got %q", resp2.Header.Get("Content-Type"))
	}
}

func TestProfile_GetAvatar_NotSet(t *testing.T) {
	s := newProfileStack(t)
	alice, _ := s.seedUser(t, "alice")
	_, bobToken := s.seedUser(t, "bob")

	resp := s.do(t, http.MethodGet, "/api/users/"+itoaInt64(alice.ID)+"/avatar", bobToken, "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for missing avatar, got %d", resp.StatusCode)
	}
}

func TestProfile_DeleteAvatar(t *testing.T) {
	s := newProfileStack(t)
	_, token := s.seedUser(t, "alice")
	resp := s.do(t, http.MethodDelete, "/api/me/avatar", token, "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

// itoaInt64 keeps this test file dependency-light — strconv would do
// just as well, but avoiding the extra import keeps the diff small.
func itoaInt64(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

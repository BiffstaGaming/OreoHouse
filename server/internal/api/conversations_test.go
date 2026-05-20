package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

type convStack struct {
	auth  *auth.Service
	convs *conversations.Service
	msgs  *messages.Service
	srv   *httptest.Server
}

func newConvStack(t *testing.T) *convStack {
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

	authSvc := auth.NewService(d, 0)
	convs := conversations.NewService(d)
	msgs := messages.NewService(d)

	r := chi.NewRouter()
	NewConversationsHandler(authSvc, convs, msgs).Mount(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	return &convStack{auth: authSvc, convs: convs, msgs: msgs, srv: srv}
}

func (s *convStack) seedUserWithSession(t *testing.T, username string) (auth.User, string) {
	t.Helper()
	ctx := context.Background()
	u, err := s.auth.CreateUser(ctx, username, "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	sess, err := s.auth.CreateSession(ctx, u.ID)
	if err != nil {
		t.Fatalf("CreateSession %s: %v", username, err)
	}
	return u, sess.Token
}

func (s *convStack) do(t *testing.T, method, path, token, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, s.srv.URL+path, strings.NewReader(body))
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
		t.Fatalf("Do: %v", err)
	}
	return resp
}

func TestRequiresAuth(t *testing.T) {
	s := newConvStack(t)
	for _, path := range []string{"/api/conversations", "/api/conversations/1/messages"} {
		resp := s.do(t, http.MethodGet, path, "", "")
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s without token: expected 401, got %d", path, resp.StatusCode)
		}
	}
	resp := s.do(t, http.MethodPost, "/api/conversations/dm", "", `{"user_id":2}`)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("POST /dm without token: expected 401, got %d", resp.StatusCode)
	}
}

func TestCreateDM_CreatesAndReturnsView(t *testing.T) {
	s := newConvStack(t)
	alice, token := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")

	resp := s.do(t, http.MethodPost, "/api/conversations/dm", token,
		fmt.Sprintf(`{"user_id":%d}`, bob.ID))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var view proto.ConversationView
	if err := json.NewDecoder(resp.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.Type != "dm" {
		t.Errorf("expected type=dm, got %q", view.Type)
	}
	if view.Name != "" {
		t.Errorf("expected empty name for DM, got %q", view.Name)
	}
	if len(view.Members) != 2 {
		t.Fatalf("expected 2 members, got %d", len(view.Members))
	}
	ids := map[int64]bool{view.Members[0].ID: true, view.Members[1].ID: true}
	if !ids[alice.ID] || !ids[bob.ID] {
		t.Errorf("expected members alice+bob, got %+v", view.Members)
	}
}

func TestCreateDM_IsIdempotent(t *testing.T) {
	s := newConvStack(t)
	_, token := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	body := fmt.Sprintf(`{"user_id":%d}`, bob.ID)

	resp1 := s.do(t, http.MethodPost, "/api/conversations/dm", token, body)
	var v1 proto.ConversationView
	_ = json.NewDecoder(resp1.Body).Decode(&v1)
	resp1.Body.Close()

	resp2 := s.do(t, http.MethodPost, "/api/conversations/dm", token, body)
	var v2 proto.ConversationView
	_ = json.NewDecoder(resp2.Body).Decode(&v2)
	resp2.Body.Close()

	if v1.ID != v2.ID {
		t.Errorf("expected same conversation on second call, got %d != %d", v1.ID, v2.ID)
	}
}

func TestCreateDM_RejectsSelf(t *testing.T) {
	s := newConvStack(t)
	alice, token := s.seedUserWithSession(t, "alice")
	resp := s.do(t, http.MethodPost, "/api/conversations/dm", token,
		fmt.Sprintf(`{"user_id":%d}`, alice.ID))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestCreateDM_RejectsMissingUserID(t *testing.T) {
	s := newConvStack(t)
	_, token := s.seedUserWithSession(t, "alice")
	resp := s.do(t, http.MethodPost, "/api/conversations/dm", token, `{}`)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestListConversations_OnlyMine(t *testing.T) {
	s := newConvStack(t)
	alice, aliceTok := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	carol, _ := s.seedUserWithSession(t, "carol")
	_, carolTok := s.seedUserWithSession(t, "dave")
	_ = carolTok

	ctx := context.Background()
	_, _ = s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	_, _ = s.convs.FindOrCreateDM(ctx, alice.ID, carol.ID)
	_, _ = s.convs.FindOrCreateDM(ctx, bob.ID, carol.ID) // not alice's

	resp := s.do(t, http.MethodGet, "/api/conversations", aliceTok, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var got proto.ListConversationsResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Conversations) != 2 {
		t.Errorf("expected 2 conversations for alice, got %d", len(got.Conversations))
	}
}

func TestListMessages_RequiresMembership(t *testing.T) {
	s := newConvStack(t)
	alice, _ := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	_, carolTok := s.seedUserWithSession(t, "carol")

	ctx := context.Background()
	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)

	// Carol is not in the alice<>bob DM — must look like "not found".
	resp := s.do(t, http.MethodGet, fmt.Sprintf("/api/conversations/%d/messages", c.ID), carolTok, "")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestListMessages_HappyPathWithPagination(t *testing.T) {
	s := newConvStack(t)
	alice, aliceTok := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	ctx := context.Background()
	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	var ids []int64
	for i := 0; i < 5; i++ {
		m, err := s.msgs.Send(ctx, c.ID, alice.ID, fmt.Sprintf("m%d", i))
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
		ids = append(ids, m.ID)
	}

	// First page (limit=2 → 2 newest).
	resp := s.do(t, http.MethodGet, fmt.Sprintf("/api/conversations/%d/messages?limit=2", c.ID), aliceTok, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var first proto.ListMessagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&first); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(first.Messages) != 2 || first.Messages[0].ID != ids[4] || first.Messages[1].ID != ids[3] {
		t.Fatalf("first page wrong: %+v", first.Messages)
	}
	if first.Messages[0].Sender.Username != "alice" {
		t.Errorf("expected sender username alice, got %q", first.Messages[0].Sender.Username)
	}

	// Second page using before = smallest id in first page.
	cursor := first.Messages[len(first.Messages)-1].ID
	resp2 := s.do(t, http.MethodGet,
		fmt.Sprintf("/api/conversations/%d/messages?limit=2&before=%d", c.ID, cursor), aliceTok, "")
	defer resp2.Body.Close()
	var second proto.ListMessagesResponse
	if err := json.NewDecoder(resp2.Body).Decode(&second); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(second.Messages) != 2 || second.Messages[0].ID != ids[2] || second.Messages[1].ID != ids[1] {
		t.Errorf("second page wrong: %+v", second.Messages)
	}
}

func TestListMessages_RejectsInvalidConversationID(t *testing.T) {
	s := newConvStack(t)
	_, token := s.seedUserWithSession(t, "alice")
	resp := s.do(t, http.MethodGet, "/api/conversations/abc/messages", token, "")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

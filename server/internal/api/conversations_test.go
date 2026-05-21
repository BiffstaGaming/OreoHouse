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

func TestCreateGroup_HappyPath(t *testing.T) {
	s := newConvStack(t)
	alice, token := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	carol, _ := s.seedUserWithSession(t, "carol")

	body := fmt.Sprintf(`{"name":"Family","member_ids":[%d,%d]}`, bob.ID, carol.ID)
	resp := s.do(t, http.MethodPost, "/api/conversations/group", token, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var view proto.ConversationView
	if err := json.NewDecoder(resp.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.Type != "group" || view.Name != "Family" {
		t.Errorf("wrong view: %+v", view)
	}
	ids := map[int64]bool{}
	for _, m := range view.Members {
		ids[m.ID] = true
	}
	if !ids[alice.ID] || !ids[bob.ID] || !ids[carol.ID] {
		t.Errorf("expected creator + 2 invitees, got %+v", view.Members)
	}
}

func TestCreateGroup_RejectsOversizeName(t *testing.T) {
	s := newConvStack(t)
	_, token := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	huge := strings.Repeat("a", 100)
	body := fmt.Sprintf(`{"name":%q,"member_ids":[%d]}`, huge, bob.ID)
	resp := s.do(t, http.MethodPost, "/api/conversations/group", token, body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestCreateRoom_HappyPath(t *testing.T) {
	s := newConvStack(t)
	_, token := s.seedUserWithSession(t, "alice")

	resp := s.do(t, http.MethodPost, "/api/conversations/room", token,
		`{"name":"general","topic":"anything goes"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var view proto.ConversationView
	_ = json.NewDecoder(resp.Body).Decode(&view)
	if view.Type != "room" || view.Name != "general" || view.Topic != "anything goes" {
		t.Errorf("wrong view: %+v", view)
	}
	if len(view.Members) != 1 {
		t.Errorf("expected creator-only initial membership, got %d", len(view.Members))
	}
}

func TestCreateRoom_RequiresName(t *testing.T) {
	s := newConvStack(t)
	_, token := s.seedUserWithSession(t, "alice")
	resp := s.do(t, http.MethodPost, "/api/conversations/room", token, `{"name":""}`)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestAddMembers_AddsToGroupRequiresCallerMember(t *testing.T) {
	s := newConvStack(t)
	alice, aliceTok := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	_, carolTok := s.seedUserWithSession(t, "carol")
	dave, _ := s.seedUserWithSession(t, "dave")

	// Alice creates a group with bob.
	g, err := s.convs.CreateGroup(context.Background(), alice.ID, "G", []int64{bob.ID})
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Carol (not a member) tries to add dave → 404.
	resp := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/conversations/%d/members", g.ID), carolTok,
		fmt.Sprintf(`{"user_ids":[%d]}`, dave.ID))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for non-member, got %d", resp.StatusCode)
	}

	// Alice (a member) adds dave → 200.
	resp2 := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/conversations/%d/members", g.ID), aliceTok,
		fmt.Sprintf(`{"user_ids":[%d]}`, dave.ID))
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp2.StatusCode)
	}
	var view proto.ConversationView
	_ = json.NewDecoder(resp2.Body).Decode(&view)
	ids := map[int64]bool{}
	for _, m := range view.Members {
		ids[m.ID] = true
	}
	if !ids[dave.ID] {
		t.Errorf("expected dave in members after add, got %+v", view.Members)
	}
}

func TestAddMembers_RejectsForRoom(t *testing.T) {
	s := newConvStack(t)
	alice, token := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	r, _ := s.convs.CreateRoom(context.Background(), alice.ID, "general", "")

	resp := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/conversations/%d/members", r.ID), token,
		fmt.Sprintf(`{"user_ids":[%d]}`, bob.ID))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for rooms, got %d", resp.StatusCode)
	}
}

func TestLeave_RemovesSelfAndRejectsDM(t *testing.T) {
	s := newConvStack(t)
	alice, aliceTok := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	ctx := context.Background()
	g, _ := s.convs.CreateGroup(ctx, alice.ID, "G", []int64{bob.ID})

	resp := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/conversations/%d/leave", g.ID), aliceTok, "")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204, got %d", resp.StatusCode)
	}
	mems, _ := s.convs.Members(ctx, g.ID)
	if len(mems) != 1 || mems[0].UserID != bob.ID {
		t.Errorf("expected only bob remaining, got %+v", mems)
	}

	dm, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	resp2 := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/conversations/%d/leave", dm.ID), aliceTok, "")
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for DM leave, got %d", resp2.StatusCode)
	}
}

func TestListRooms_ReturnsAllRoomsWithCounts(t *testing.T) {
	s := newConvStack(t)
	alice, token := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	ctx := context.Background()
	r1, _ := s.convs.CreateRoom(ctx, alice.ID, "general", "")
	_ = s.convs.AddMember(ctx, r1.ID, bob.ID)
	_, _ = s.convs.CreateRoom(ctx, alice.ID, "lounge", "afterhours")

	resp := s.do(t, http.MethodGet, "/api/rooms", token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body proto.ListRoomsResponse
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if len(body.Rooms) != 2 {
		t.Errorf("expected 2 rooms, got %d", len(body.Rooms))
	}
	// Newest first → lounge then general.
	if body.Rooms[0].Name != "lounge" {
		t.Errorf("expected newest first (lounge), got %q", body.Rooms[0].Name)
	}
	if body.Rooms[1].Name != "general" || body.Rooms[1].MemberCount != 2 {
		t.Errorf("expected general w/ 2 members, got %+v", body.Rooms[1])
	}
}

func TestJoinRoom_AddsCallerAsMemberAndIsIdempotent(t *testing.T) {
	s := newConvStack(t)
	alice, _ := s.seedUserWithSession(t, "alice")
	_, bobTok := s.seedUserWithSession(t, "bob")
	ctx := context.Background()
	r, _ := s.convs.CreateRoom(ctx, alice.ID, "general", "")

	resp := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/rooms/%d/join", r.ID), bobTok, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var view proto.ConversationView
	_ = json.NewDecoder(resp.Body).Decode(&view)
	if len(view.Members) != 2 {
		t.Errorf("expected 2 members after join, got %d", len(view.Members))
	}

	// Join again — should still succeed and still report 2 members.
	resp2 := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/rooms/%d/join", r.ID), bobTok, "")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("expected 200 on idempotent join, got %d", resp2.StatusCode)
	}
}

func TestJoinRoom_RejectsGroup(t *testing.T) {
	s := newConvStack(t)
	alice, _ := s.seedUserWithSession(t, "alice")
	_, bobTok := s.seedUserWithSession(t, "bob")
	g, _ := s.convs.CreateGroup(context.Background(), alice.ID, "private", nil)

	resp := s.do(t, http.MethodPost,
		fmt.Sprintf("/api/rooms/%d/join", g.ID), bobTok, "")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 (not a room), got %d", resp.StatusCode)
	}
}

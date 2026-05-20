package ws

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

type testStack struct {
	db   *sql.DB
	auth *auth.Service
	hub  *Hub
	srv  *httptest.Server
}

func newTestStack(t *testing.T) *testStack {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(ctx, d, server.Migrations()); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	svc := auth.NewService(d, 0)
	hub := NewHub()
	hubCtx, hubCancel := context.WithCancel(context.Background())
	go hub.Run(hubCtx)
	h := NewHandler(hub, svc)
	srv := httptest.NewServer(h)
	t.Cleanup(func() {
		srv.Close()
		hubCancel()
		_ = d.Close()
	})
	return &testStack{db: d, auth: svc, hub: hub, srv: srv}
}

// seedUser creates a user via the service and returns a fresh session token
// for them. Caller uses the token in the ?token= query parameter.
func (s *testStack) seedUser(t *testing.T, username string) (auth.User, string) {
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

func (s *testStack) dial(t *testing.T, token string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(s.srv.URL, "http://", "ws://", 1) + "/?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close(websocket.StatusNormalClosure, "test done") })
	return c
}

func readMessage(t *testing.T, c *websocket.Conn) (string, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("decode envelope: %v (raw=%s)", err, data)
	}
	return env.Type, data
}

// Note: we deliberately avoid an "expectNoMessage" helper here.
// coder/websocket treats any Read error (including a context timeout)
// as terminal for the connection, so a bare "read with short timeout
// expecting timeout" call would kill the conn for any following
// assertion. Instead, structure tests so the next message we expect
// to read is unambiguous — if a stray event slips in, the assertion
// on the expected next type fails.

func TestHandler_RejectsMissingToken(t *testing.T) {
	s := newTestStack(t)
	wsURL := strings.Replace(s.srv.URL, "http://", "ws://", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, wsURL+"/", nil)
	if err == nil {
		t.Fatal("expected dial to fail without ?token=")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %v", resp)
	}
}

func TestHandler_RejectsInvalidToken(t *testing.T) {
	s := newTestStack(t)
	wsURL := strings.Replace(s.srv.URL, "http://", "ws://", 1) + "/?token=garbage"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("expected dial to fail with bad token")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %v", resp)
	}
}

func TestHandler_SendsWelcomeOnConnect(t *testing.T) {
	s := newTestStack(t)
	alice, token := s.seedUser(t, "alice")
	c := s.dial(t, token)

	typ, raw := readMessage(t, c)
	if typ != proto.TypeWelcome {
		t.Fatalf("expected first message to be welcome, got %q", typ)
	}
	var msg proto.WelcomeMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("decode welcome: %v", err)
	}
	if msg.You.ID != alice.ID || msg.You.Username != "alice" {
		t.Errorf("welcome.you mismatch: got %+v", msg.You)
	}
	if len(msg.Online) != 1 || msg.Online[0].ID != alice.ID {
		t.Errorf("expected online=[alice], got %+v", msg.Online)
	}
}

func TestHandler_BroadcastsPresenceOnFirstConnect(t *testing.T) {
	s := newTestStack(t)
	_, aliceToken := s.seedUser(t, "alice")
	bob, bobToken := s.seedUser(t, "bob")

	aliceConn := s.dial(t, aliceToken)
	if typ, _ := readMessage(t, aliceConn); typ != proto.TypeWelcome {
		t.Fatalf("alice: expected welcome, got %q", typ)
	}
	// alice receives presence about herself (self-broadcast on first connect).
	if typ, _ := readMessage(t, aliceConn); typ != proto.TypePresence {
		t.Fatalf("alice: expected self-presence, got %q", typ)
	}

	// bob connects → alice should receive a presence for bob.
	_ = s.dial(t, bobToken)

	typ, raw := readMessage(t, aliceConn)
	if typ != proto.TypePresence {
		t.Fatalf("alice: expected presence about bob, got %q", typ)
	}
	var pres proto.PresenceMessage
	if err := json.Unmarshal(raw, &pres); err != nil {
		t.Fatalf("decode presence: %v", err)
	}
	if pres.User.ID != bob.ID || pres.Status != proto.StatusOnline {
		t.Errorf("expected presence(bob,online), got %+v", pres)
	}
}

func TestHandler_NoPresenceOnSecondConnection(t *testing.T) {
	s := newTestStack(t)
	alice, aliceToken := s.seedUser(t, "alice")
	_, bobToken := s.seedUser(t, "bob")

	aliceConn1 := s.dial(t, aliceToken)
	_, _ = readMessage(t, aliceConn1) // welcome
	_, _ = readMessage(t, aliceConn1) // self-presence (alice online)

	bobConn := s.dial(t, bobToken)
	_, _ = readMessage(t, bobConn)    // welcome
	_, _ = readMessage(t, bobConn)    // self-presence (bob online)
	_, _ = readMessage(t, aliceConn1) // presence(bob, online)

	// Alice opens a second connection — must NOT emit any presence
	// broadcast.
	aliceConn2 := s.dial(t, aliceToken)
	_, _ = readMessage(t, aliceConn2) // welcome only

	// Disconnect both alice connections. The only presence bob should
	// see is the eventual offline event — if alice2's connect had
	// erroneously broadcast, it would appear before the offline.
	_ = aliceConn1.Close(websocket.StatusNormalClosure, "close 1")
	_ = aliceConn2.Close(websocket.StatusNormalClosure, "close 2")

	typ, raw := readMessage(t, bobConn)
	if typ != proto.TypePresence {
		t.Fatalf("bob: expected next message to be presence(alice,offline), got %q", typ)
	}
	var pres proto.PresenceMessage
	if err := json.Unmarshal(raw, &pres); err != nil {
		t.Fatalf("decode presence: %v", err)
	}
	if pres.User.ID != alice.ID || pres.Status != proto.StatusOffline {
		t.Errorf("expected presence(alice,offline) as first new message after second-conn dance; got %+v", pres)
	}
}

func TestHandler_BroadcastsOfflineOnLastDisconnect(t *testing.T) {
	s := newTestStack(t)
	alice, aliceToken := s.seedUser(t, "alice")
	_, bobToken := s.seedUser(t, "bob")

	aliceConn1 := s.dial(t, aliceToken)
	// drain
	_, _ = readMessage(t, aliceConn1)
	_, _ = readMessage(t, aliceConn1)

	aliceConn2 := s.dial(t, aliceToken)
	// alice2 sees welcome (no self-presence because it's not first conn)
	if typ, _ := readMessage(t, aliceConn2); typ != proto.TypeWelcome {
		t.Fatalf("alice2: expected welcome, got %q", typ)
	}

	bobConn := s.dial(t, bobToken)
	// drain bob's welcome + self-presence
	_, _ = readMessage(t, bobConn)
	_, _ = readMessage(t, bobConn)

	// Close alice's first connection. Because alice still has alice2
	// connected, the server must NOT broadcast offline. We can't check
	// that with a "no message" read (coder/websocket would kill the
	// conn), so instead we observe that the first event bob sees
	// after we then close alice2 is the offline event itself — if
	// alice1's close had erroneously broadcast, that earlier presence
	// would arrive first and fail the assertion below.
	_ = aliceConn1.Close(websocket.StatusNormalClosure, "close 1")
	// Give the server a moment to process alice1's unregister so
	// alice2's close definitively comes second.
	time.Sleep(100 * time.Millisecond)
	_ = aliceConn2.Close(websocket.StatusNormalClosure, "close 2")
	typ, raw := readMessage(t, bobConn)
	if typ != proto.TypePresence {
		t.Fatalf("bob: expected presence(alice,offline), got %q", typ)
	}
	var pres proto.PresenceMessage
	if err := json.Unmarshal(raw, &pres); err != nil {
		t.Fatalf("decode presence: %v", err)
	}
	if pres.User.ID != alice.ID || pres.Status != proto.StatusOffline {
		t.Errorf("expected presence(alice,offline), got %+v", pres)
	}
}

func TestHandler_PingReturnsPong(t *testing.T) {
	s := newTestStack(t)
	_, token := s.seedUser(t, "alice")
	c := s.dial(t, token)

	// drain welcome + self-presence
	_, _ = readMessage(t, c)
	_, _ = readMessage(t, c)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ping, _ := json.Marshal(proto.PingMessage{Type: proto.TypePing})
	if err := c.Write(ctx, websocket.MessageText, ping); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	if typ, _ := readMessage(t, c); typ != proto.TypePong {
		t.Errorf("expected pong, got %q", typ)
	}
}

func TestHandler_UpdatesLastSeenOnDisconnect(t *testing.T) {
	s := newTestStack(t)
	alice, token := s.seedUser(t, "alice")
	c := s.dial(t, token)
	// drain welcome + self-presence
	_, _ = readMessage(t, c)
	_, _ = readMessage(t, c)

	// Close the connection and wait for the server to finish cleanup.
	_ = c.Close(websocket.StatusNormalClosure, "test done")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var lastSeen sql.NullString
		if err := s.db.QueryRow("SELECT last_seen_at FROM users WHERE id = ?", alice.ID).Scan(&lastSeen); err == nil && lastSeen.Valid {
			return // success
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("last_seen_at was not updated within 2s for user %d", alice.ID)
}

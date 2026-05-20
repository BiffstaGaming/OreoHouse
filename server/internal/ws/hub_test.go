package ws

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
)

func startTestHub(t *testing.T) *Hub {
	t.Helper()
	h := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	go h.Run(ctx)
	t.Cleanup(cancel)
	return h
}

func TestHub_RegisterReturnsFirstConnTrue(t *testing.T) {
	h := startTestHub(t)
	c := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	if first := h.Register(c); !first {
		t.Errorf("expected first=true on first connection")
	}
}

func TestHub_RegisterSecondConnReturnsFalse(t *testing.T) {
	h := startTestHub(t)
	c1 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	c2 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	h.Register(c1)
	if first := h.Register(c2); first {
		t.Errorf("expected first=false on user's second connection")
	}
}

func TestHub_UnregisterLastConnReturnsTrue(t *testing.T) {
	h := startTestHub(t)
	c := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	h.Register(c)
	if last := h.Unregister(c); !last {
		t.Errorf("expected last=true when only connection unregisters")
	}
}

func TestHub_UnregisterOfTwoReturnsFalseThenTrue(t *testing.T) {
	h := startTestHub(t)
	c1 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	c2 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	h.Register(c1)
	h.Register(c2)
	if last := h.Unregister(c1); last {
		t.Errorf("expected last=false on first of two unregisters")
	}
	if last := h.Unregister(c2); !last {
		t.Errorf("expected last=true on second of two unregisters")
	}
}

func TestHub_OnlineUsersUniquePerUserID(t *testing.T) {
	h := startTestHub(t)
	alice := auth.User{ID: 1, Username: "alice"}
	bob := auth.User{ID: 2, Username: "bob"}
	h.Register(newClient(alice, 4))
	h.Register(newClient(alice, 4)) // alice's second connection
	h.Register(newClient(bob, 4))

	online := h.OnlineUsers()
	if len(online) != 2 {
		t.Fatalf("expected 2 unique online users, got %d", len(online))
	}
	ids := map[int64]bool{}
	for _, u := range online {
		ids[u.ID] = true
	}
	if !ids[1] || !ids[2] {
		t.Errorf("expected ids 1 and 2 in OnlineUsers, got %+v", online)
	}
}

func TestHub_OnlineUsersAfterAllUnregistered(t *testing.T) {
	h := startTestHub(t)
	c := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	h.Register(c)
	h.Unregister(c)
	online := h.OnlineUsers()
	if len(online) != 0 {
		t.Errorf("expected 0 online users after unregister, got %d", len(online))
	}
}

func TestHub_BroadcastDeliversToAllClients(t *testing.T) {
	h := startTestHub(t)
	c1 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	c2 := newClient(auth.User{ID: 2, Username: "bob"}, 4)
	h.Register(c1)
	h.Register(c2)
	h.Broadcast([]byte("hello"))

	for i, c := range []*Client{c1, c2} {
		select {
		case msg := <-c.send:
			if string(msg) != "hello" {
				t.Errorf("client %d got %q, want hello", i, msg)
			}
		case <-time.After(time.Second):
			t.Errorf("client %d did not receive broadcast", i)
		}
	}
}

func TestHub_BroadcastDoesNotBlockOnFullClientBuffer(t *testing.T) {
	h := startTestHub(t)
	c := newClient(auth.User{ID: 1, Username: "alice"}, 1) // tiny buffer
	h.Register(c)
	// Fill the client's buffer manually so the next broadcast can't be queued.
	c.send <- []byte("queued")

	done := make(chan struct{})
	go func() {
		h.Broadcast([]byte("would-block"))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("Broadcast blocked when client buffer was full")
	}
}

func TestHub_SendToUsersDeliversOnlyToTargetUsers(t *testing.T) {
	h := startTestHub(t)
	c1 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	c2 := newClient(auth.User{ID: 2, Username: "bob"}, 4)
	c3 := newClient(auth.User{ID: 3, Username: "carol"}, 4)
	h.Register(c1)
	h.Register(c2)
	h.Register(c3)

	delivered := h.SendToUsers([]byte("hi alice and bob"), []int64{1, 2})
	if len(delivered) != 2 {
		t.Errorf("expected 2 delivered, got %v", delivered)
	}

	for _, c := range []*Client{c1, c2} {
		select {
		case msg := <-c.send:
			if string(msg) != "hi alice and bob" {
				t.Errorf("client %d wrong body: %s", c.user.ID, msg)
			}
		case <-time.After(time.Second):
			t.Errorf("client %d did not receive", c.user.ID)
		}
	}
	// Carol should not receive.
	select {
	case msg := <-c3.send:
		t.Errorf("carol received unexpected message: %s", msg)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestHub_SendToUsersSkipsOfflineUsers(t *testing.T) {
	h := startTestHub(t)
	c1 := newClient(auth.User{ID: 1, Username: "alice"}, 4)
	h.Register(c1)
	delivered := h.SendToUsers([]byte("hello"), []int64{1, 99})
	if len(delivered) != 1 || delivered[0] != 1 {
		t.Errorf("expected delivered=[1], got %v", delivered)
	}
}

func TestHub_SendToUsersEmptySliceIsCheap(t *testing.T) {
	h := startTestHub(t)
	delivered := h.SendToUsers([]byte("hi"), nil)
	if len(delivered) != 0 {
		t.Errorf("expected no deliveries for empty users, got %v", delivered)
	}
}

func TestHub_ConcurrentRegisterUnregister(t *testing.T) {
	h := startTestHub(t)
	var wg sync.WaitGroup
	const N = 50
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			c := newClient(auth.User{ID: id, Username: "u"}, 4)
			h.Register(c)
			h.Unregister(c)
		}(int64(i + 1))
	}
	wg.Wait()
	online := h.OnlineUsers()
	if len(online) != 0 {
		t.Errorf("expected 0 online users after concurrent register/unregister, got %d", len(online))
	}
}

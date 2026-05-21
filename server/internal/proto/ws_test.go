package proto

import (
	"encoding/json"
	"testing"
)

func TestEnvelope_ReadsTypeFromAnyMessage(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"welcome", `{"type":"welcome","you":{"id":1,"username":"a","created_at":"t"},"online":[]}`, TypeWelcome},
		{"presence", `{"type":"presence","user":{"id":1,"username":"a","created_at":"t"},"state":"online"}`, TypePresence},
		{"error", `{"type":"error","code":"x","message":"y"}`, TypeError},
		{"ping", `{"type":"ping"}`, TypePing},
		{"pong", `{"type":"pong"}`, TypePong},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var env Envelope
			if err := json.Unmarshal([]byte(tc.raw), &env); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if env.Type != tc.want {
				t.Errorf("got %q, want %q", env.Type, tc.want)
			}
		})
	}
}

func TestWelcomeMessage_RoundTrip(t *testing.T) {
	in := WelcomeMessage{
		Type: TypeWelcome,
		You:  UserInfo{ID: 1, Username: "alice", CreatedAt: "2026-05-21T00:00:00Z"},
		Online: []PresenceInfo{
			{
				User:  UserInfo{ID: 1, Username: "alice", CreatedAt: "2026-05-21T00:00:00Z"},
				State: StateOnline,
			},
			{
				User:       UserInfo{ID: 2, Username: "bob", CreatedAt: "2026-05-21T00:00:00Z"},
				State:      StateAway,
				CustomText: "BRB",
			},
		},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out WelcomeMessage
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.You.ID != 1 || out.You.Username != "alice" {
		t.Errorf("You round-trip lost data: %+v", out.You)
	}
	if len(out.Online) != 2 || out.Online[1].User.Username != "bob" ||
		out.Online[1].State != StateAway || out.Online[1].CustomText != "BRB" {
		t.Errorf("Online round-trip lost data: %+v", out.Online)
	}
}

func TestPresenceMessage_RoundTrip(t *testing.T) {
	in := PresenceMessage{
		Type:       TypePresence,
		User:       UserInfo{ID: 1, Username: "alice", CreatedAt: "2026-05-21T00:00:00Z"},
		State:      StateAway,
		CustomText: "out for lunch",
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out PresenceMessage
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.User.ID != 1 || out.State != StateAway ||
		out.CustomText != "out for lunch" || out.Type != TypePresence {
		t.Errorf("round trip mismatch: %+v", out)
	}
}

func TestValidUserState(t *testing.T) {
	for _, ok := range []string{StateOnline, StateAway, StateBusy} {
		if !ValidUserState(ok) {
			t.Errorf("expected %q to be valid", ok)
		}
	}
	for _, bad := range []string{StateOffline, "", "invisible", "garbage"} {
		if ValidUserState(bad) {
			t.Errorf("expected %q to be invalid", bad)
		}
	}
}

func TestErrorMessage_RoundTrip(t *testing.T) {
	in := ErrorMessage{Type: TypeError, Code: ErrCodeInvalidMessage, Message: "expected object"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out ErrorMessage
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Code != ErrCodeInvalidMessage || out.Message != "expected object" {
		t.Errorf("round trip mismatch: %+v", out)
	}
}

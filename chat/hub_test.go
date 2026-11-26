package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHubPublishAndHistoryLimit(t *testing.T) {
	hub := newHub()
	user := AuthUser{ID: 1, Email: "alice@example.com"}

	if _, ok := hub.publish("general", user, "   "); ok {
		t.Fatal("expected empty message to be rejected")
	}

	tooLong := strings.Repeat("a", maxMessageRunes+1)
	if _, ok := hub.publish("general", user, tooLong); ok {
		t.Fatal("expected oversized message to be rejected")
	}

	for i := 0; i < maxHistoryPerRoom+15; i++ {
		if _, ok := hub.publish("general", user, "hello"); !ok {
			t.Fatalf("publish %d failed", i)
		}
	}

	hist := hub.getHistory("general")
	if len(hist) != maxHistoryPerRoom {
		t.Fatalf("expected %d messages in history, got %d", maxHistoryPerRoom, len(hist))
	}
}

func TestHubRoomIsolationAndBroadcast(t *testing.T) {
	hub := newHub()
	c1 := &Client{
		hub:  hub,
		user: AuthUser{ID: 1, Email: "alice@example.com"},
		room: "general",
		send: make(chan []byte, clientSendBufSize),
	}
	c2 := &Client{
		hub:  hub,
		user: AuthUser{ID: 2, Email: "bob@example.com"},
		room: "stream",
		send: make(chan []byte, clientSendBufSize),
	}

	hub.register(c1)
	hub.register(c2)

	// Drain initial history and presence frames.
	for len(c1.send) > 0 {
		<-c1.send
	}
	for len(c2.send) > 0 {
		<-c2.send
	}

	msg, ok := hub.publish("general", c1.user, "hi general")
	if !ok {
		t.Fatal("expected publish to succeed")
	}

	select {
	case raw := <-c1.send:
		var out wsOutbound
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if out.Type != "message" || out.Message == nil || out.Message.ID != msg.ID {
			t.Fatalf("unexpected outbound payload: %+v", out)
		}
	default:
		t.Fatal("expected c1 in general room to receive message")
	}

	select {
	case raw := <-c2.send:
		t.Fatalf("expected c2 in stream room not to receive general message, got %s", string(raw))
	default:
	}

	hub.unregister(c1)
	hub.unregister(c2)
}

func TestComputeAcceptKey(t *testing.T) {
	// RFC 6455 Section 1.3 example key.
	got := computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got != want {
		t.Fatalf("computeAcceptKey() = %q, want %q", got, want)
	}
}

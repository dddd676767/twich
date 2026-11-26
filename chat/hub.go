package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxHistoryPerRoom = 100
	maxMessageRunes   = 500
	defaultRoomName   = "general"
	clientSendBufSize = 64
)

// AuthUser represents an authenticated user returned by the FastAPI backend.
type AuthUser struct {
	ID    int    `json:"id"`
	Email string `json:"email"`
}

// ChatMessage is a single message stored in room history and broadcast to clients.
type ChatMessage struct {
	ID        string    `json:"id"`
	Room      string    `json:"room"`
	UserID    int       `json:"userId"`
	Email     string    `json:"email"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
}

type wsOutbound struct {
	Type        string        `json:"type"`
	Room        string        `json:"room,omitempty"`
	Messages    []ChatMessage `json:"messages,omitempty"`
	Message     *ChatMessage  `json:"message,omitempty"`
	OnlineCount int           `json:"onlineCount,omitempty"`
	Error       string        `json:"error,omitempty"`
}

type wsInbound struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Client represents a connected WebSocket user in a specific room.
type Client struct {
	hub  *Hub
	conn *wsConn
	user AuthUser
	room string
	send chan []byte
}

// Hub manages chat rooms, connected clients, and recent message history.
type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]map[*Client]struct{}
	history map[string][]ChatMessage
}

func newHub() *Hub {
	return &Hub{
		rooms:   make(map[string]map[*Client]struct{}),
		history: make(map[string][]ChatMessage),
	}
}

func normalizeRoom(room string) string {
	room = strings.TrimSpace(strings.ToLower(room))
	if room == "" {
		return defaultRoomName
	}
	if len(room) > 64 {
		room = room[:64]
	}
	return room
}

func newMessageID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(b[:])
}

// register adds a client to its room, sends room history, and broadcasts updated presence.
func (h *Hub) register(c *Client) {
	h.mu.Lock()
	clients, ok := h.rooms[c.room]
	if !ok {
		clients = make(map[*Client]struct{})
		h.rooms[c.room] = clients
	}
	clients[c] = struct{}{}
	onlineCount := len(clients)

	hist := make([]ChatMessage, len(h.history[c.room]))
	copy(hist, h.history[c.room])
	h.mu.Unlock()

	if data, err := json.Marshal(wsOutbound{
		Type:        "history",
		Room:        c.room,
		Messages:    hist,
		OnlineCount: onlineCount,
	}); err == nil {
		enqueue(c, data)
	}

	h.broadcastPresence(c.room, onlineCount)
}

// unregister removes a client from its room and closes its outbound channel.
func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	clients, ok := h.rooms[c.room]
	if !ok {
		h.mu.Unlock()
		return
	}
	if _, exists := clients[c]; !exists {
		h.mu.Unlock()
		return
	}
	delete(clients, c)
	close(c.send)
	onlineCount := len(clients)
	if onlineCount == 0 {
		delete(h.rooms, c.room)
	}
	h.mu.Unlock()

	if onlineCount > 0 {
		h.broadcastPresence(c.room, onlineCount)
	}
}

// publish validates and stores a new message, then broadcasts it to everyone in the room.
func (h *Hub) publish(room string, user AuthUser, rawText string) (ChatMessage, bool) {
	text := strings.TrimSpace(rawText)
	if text == "" || utf8.RuneCountInString(text) > maxMessageRunes {
		return ChatMessage{}, false
	}

	msg := ChatMessage{
		ID:        newMessageID(),
		Room:      room,
		UserID:    user.ID,
		Email:     user.Email,
		Text:      text,
		CreatedAt: time.Now().UTC(),
	}

	payload, err := json.Marshal(wsOutbound{
		Type:    "message",
		Room:    room,
		Message: &msg,
	})
	if err != nil {
		log.Printf("failed to marshal chat message: %v", err)
		return ChatMessage{}, false
	}

	h.mu.Lock()
	hist := append(h.history[room], msg)
	if len(hist) > maxHistoryPerRoom {
		hist = hist[len(hist)-maxHistoryPerRoom:]
	}
	h.history[room] = hist

	targets := make([]*Client, 0, len(h.rooms[room]))
	for c := range h.rooms[room] {
		targets = append(targets, c)
	}
	h.mu.Unlock()

	for _, c := range targets {
		enqueue(c, payload)
	}
	return msg, true
}

// getHistory returns a copy of recent messages for the given room.
func (h *Hub) getHistory(room string) []ChatMessage {
	room = normalizeRoom(room)
	h.mu.RLock()
	defer h.mu.RUnlock()

	hist := make([]ChatMessage, len(h.history[room]))
	copy(hist, h.history[room])
	return hist
}

func (h *Hub) broadcastPresence(room string, onlineCount int) {
	payload, err := json.Marshal(wsOutbound{
		Type:        "presence",
		Room:        room,
		OnlineCount: onlineCount,
	})
	if err != nil {
		return
	}

	h.mu.RLock()
	targets := make([]*Client, 0, len(h.rooms[room]))
	for c := range h.rooms[room] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		enqueue(c, payload)
	}
}

func enqueue(c *Client, payload []byte) {
	select {
	case c.send <- payload:
	default:
		// Drop outbound frame if client send buffer is full to avoid blocking the room.
	}
}

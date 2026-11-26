package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	defaultChatPort = "8080"
	defaultAuthURL  = "http://127.0.0.1:8000"
	pingInterval    = 25 * time.Second
)

type chatServer struct {
	hub        *Hub
	authURL    string
	httpClient *http.Client
}

func newChatServer(authURL string) *chatServer {
	return &chatServer{
		hub:     newHub(),
		authURL: strings.TrimRight(authURL, "/"),
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (s *chatServer) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /api/messages", s.handleGetMessages)
	mux.HandleFunc("GET /ws", s.handleWS)
	return withCORS(mux)
}

func (s *chatServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *chatServer) handleGetMessages(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	if token == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"detail": "missing authorization token"})
		return
	}
	if _, err := s.verifyToken(r.Context(), token); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"detail": "invalid or expired token"})
		return
	}

	room := normalizeRoom(r.URL.Query().Get("room"))
	writeJSON(w, http.StatusOK, map[string]any{
		"room":     room,
		"messages": s.hub.getHistory(room),
	})
}

func (s *chatServer) handleWS(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	if token == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	user, err := s.verifyToken(r.Context(), token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	ws, err := upgradeWebSocket(w, r)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	room := normalizeRoom(r.URL.Query().Get("room"))
	client := &Client{
		hub:  s.hub,
		conn: ws,
		user: user,
		room: room,
		send: make(chan []byte, clientSendBufSize),
	}

	s.hub.register(client)
	go s.writePump(client)
	s.readPump(client)
}

func (s *chatServer) readPump(c *Client) {
	defer func() {
		s.hub.unregister(c)
		_ = c.conn.close()
	}()

	for {
		raw, err := c.conn.readMessage()
		if err != nil {
			return
		}

		var in wsInbound
		if err := json.Unmarshal(raw, &in); err != nil {
			sendError(c, "invalid JSON payload")
			continue
		}

		if in.Type != "" && in.Type != "message" {
			continue
		}

		if _, ok := s.hub.publish(c.room, c.user, in.Text); !ok {
			sendError(c, fmt.Sprintf("message must be 1..%d characters", maxMessageRunes))
		}
	}
}

func (s *chatServer) writePump(c *Client) {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = c.conn.close()
	}()

	for {
		select {
		case payload, ok := <-c.send:
			if !ok {
				_ = c.conn.writeFrame(opClose, nil)
				return
			}
			if err := c.conn.writeText(payload); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.conn.writePing(); err != nil {
				return
			}
		}
	}
}

// verifyToken validates the JWT against the FastAPI /me endpoint and returns the user profile.
func (s *chatServer) verifyToken(ctx context.Context, token string) (AuthUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.authURL+"/me", nil)
	if err != nil {
		return AuthUser{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return AuthUser{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return AuthUser{}, errors.New("token rejected by auth service")
	}

	var user AuthUser
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return AuthUser{}, err
	}
	if user.ID == 0 || user.Email == "" {
		return AuthUser{}, errors.New("incomplete user profile")
	}
	return user, nil
}

func extractToken(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func sendError(c *Client, msg string) {
	if data, err := json.Marshal(wsOutbound{
		Type:  "error",
		Error: msg,
	}); err == nil {
		enqueue(c, data)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func envOrDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func main() {
	port := envOrDefault("CHAT_PORT", defaultChatPort)
	authURL := envOrDefault("AUTH_URL", defaultAuthURL)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           newChatServer(authURL).routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("Go chat service listening on http://127.0.0.1:%s (auth: %s)", port, authURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown error: %v", err)
	}
}

// Package api implements the HTTP REST handlers for OreoHouse.
//
// Phase 1: POST /api/auth/login and POST /api/auth/logout.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// maxLoginBodyBytes caps the size of a /login request body. 1 KiB is
// plenty for a username + password; refusing anything bigger keeps
// pathological clients from making the server allocate.
const maxLoginBodyBytes = 1 << 10

// AuthHandler serves /api/auth/* endpoints. Construct via NewAuthHandler.
type AuthHandler struct {
	svc *auth.Service
}

// NewAuthHandler wraps an auth.Service with HTTP handlers.
func NewAuthHandler(svc *auth.Service) *AuthHandler {
	return &AuthHandler{svc: svc}
}

// Mount registers the /api/auth/* routes on r.
func (h *AuthHandler) Mount(r chi.Router) {
	r.Post("/api/auth/login", h.Login)
	r.Post("/api/auth/logout", h.Logout)
}

// Login handles POST /api/auth/login.
//
//	{ "username": "alice", "password": "..." }
//	→ 200 { token, expires_at?, user: { id, username, created_at } }
//	→ 400 if body is missing/malformed
//	→ 401 on bad credentials
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req proto.LoginRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "username and password are required")
		return
	}
	user, err := h.svc.Authenticate(r.Context(), req.Username, req.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeJSONError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		slog.Error("login: authenticate failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	sess, err := h.svc.CreateSession(r.Context(), user.ID)
	if err != nil {
		slog.Error("login: create session failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	resp := proto.LoginResponse{
		Token: sess.Token,
		User: proto.UserInfo{
			ID:            user.ID,
			Username:      user.Username,
			CreatedAt:     user.CreatedAt.UTC().Format(time.RFC3339Nano),
			DisplayName:   user.DisplayName,
			HasAvatar:     user.AvatarAttachmentID > 0,
			AvatarVersion: user.AvatarAttachmentID,
		},
	}
	if !sess.ExpiresAt.IsZero() {
		resp.ExpiresAt = sess.ExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	writeJSON(w, http.StatusOK, resp)
}

// Logout handles POST /api/auth/logout. Requires an Authorization
// header of the form "Bearer <token>". Idempotent — succeeds whether
// or not the token corresponds to a live session.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	token := bearerToken(r)
	if token == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing or malformed Authorization header")
		return
	}
	if err := h.svc.DeleteSession(r.Context(), token); err != nil {
		slog.Error("logout: delete session failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// bearerToken extracts the token from an "Authorization: Bearer <t>"
// header. Returns "" if the header is missing or doesn't match.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

func decodeJSON(r io.Reader, v any) error {
	dec := json.NewDecoder(io.LimitReader(r, maxLoginBodyBytes))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, proto.ErrorResponse{Error: msg})
}

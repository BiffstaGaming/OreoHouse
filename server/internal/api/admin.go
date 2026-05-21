package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

// maxAdminBodyBytes caps the size of any admin-API JSON body. The
// requests we accept (create user, set password) are tiny.
const maxAdminBodyBytes = 1 << 10

// AdminHandler serves /api/admin/* endpoints. Every route requires the
// caller to be authenticated AND flagged as is_admin in the database.
type AdminHandler struct {
	svc *auth.Service
}

// NewAdminHandler wraps an auth.Service with admin HTTP handlers.
func NewAdminHandler(svc *auth.Service) *AdminHandler {
	return &AdminHandler{svc: svc}
}

// Mount registers the /api/admin/* routes behind requireAdmin.
func (h *AdminHandler) Mount(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(requireAdmin(h.svc))
		r.Get("/api/admin/users", h.listUsers)
		r.Post("/api/admin/users", h.createUser)
		r.Put("/api/admin/users/{id}/password", h.setPassword)
	})
}

// listUsers handles GET /api/admin/users.
func (h *AdminHandler) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.svc.ListUsersDetail(r.Context())
	if err != nil {
		slog.Error("admin: list users failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]proto.AdminUserView, 0, len(users))
	for _, u := range users {
		v := proto.AdminUserView{
			ID:        u.ID,
			Username:  u.Username,
			CreatedAt: u.CreatedAt.UTC().Format(time.RFC3339Nano),
			IsAdmin:   u.IsAdmin,
		}
		if !u.LastSeenAt.IsZero() {
			v.LastSeenAt = u.LastSeenAt.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, proto.ListAdminUsersResponse{Users: out})
}

// createUser handles POST /api/admin/users.
//
//	{ "username": "alice", "password": "..." }
//	→ 201 { user: AdminUserView }
//	→ 400 invalid JSON / validation failure
//	→ 409 username taken
func (h *AdminHandler) createUser(w http.ResponseWriter, r *http.Request) {
	var req proto.CreateAdminUserRequest
	if err := decodeAdminJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	user, err := h.svc.CreateUser(r.Context(), req.Username, req.Password)
	switch {
	case errors.Is(err, auth.ErrInvalidUsername):
		writeJSONError(w, http.StatusBadRequest, "invalid username")
		return
	case errors.Is(err, auth.ErrPasswordTooShort):
		writeJSONError(w, http.StatusBadRequest, auth.ErrPasswordTooShort.Error())
		return
	case errors.Is(err, auth.ErrUserExists):
		writeJSONError(w, http.StatusConflict, "username already taken")
		return
	case err != nil:
		slog.Error("admin: create user failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		User proto.AdminUserView `json:"user"`
	}{
		User: proto.AdminUserView{
			ID:        user.ID,
			Username:  user.Username,
			CreatedAt: user.CreatedAt.UTC().Format(time.RFC3339Nano),
			IsAdmin:   user.IsAdmin,
		},
	})
}

// setPassword handles PUT /api/admin/users/{id}/password.
//
//	{ "password": "..." }
//	→ 204 on success
//	→ 400 missing / too short
//	→ 404 unknown user
func (h *AdminHandler) setPassword(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	var req proto.SetAdminUserPasswordRequest
	if err := decodeAdminJSON(r.Body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	switch err := h.svc.SetPassword(r.Context(), id, req.Password); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, auth.ErrPasswordTooShort):
		writeJSONError(w, http.StatusBadRequest, auth.ErrPasswordTooShort.Error())
	case errors.Is(err, auth.ErrUserNotFound):
		writeJSONError(w, http.StatusNotFound, "user not found")
	default:
		slog.Error("admin: set password failed", "error", err, "user_id", id)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
	}
}

func decodeAdminJSON(r io.Reader, v any) error {
	dec := json.NewDecoder(io.LimitReader(r, maxAdminBodyBytes))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

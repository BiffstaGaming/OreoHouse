package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
)

// ctxKey is unexported to keep collisions in r.Context() impossible.
type ctxKey int

const ctxUserKey ctxKey = iota

// UserFromContext returns the user injected by requireAuth (true) or
// the zero User and false if the middleware didn't run.
func UserFromContext(ctx context.Context) (auth.User, bool) {
	u, ok := ctx.Value(ctxUserKey).(auth.User)
	return u, ok
}

// requireAuth produces a chi-compatible middleware that validates the
// Authorization: Bearer <token> header against svc and injects the
// resolved auth.User into the request context. Rejects with HTTP 401
// on missing, malformed, or expired tokens.
func requireAuth(svc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerToken(r)
			if token == "" {
				writeJSONError(w, http.StatusUnauthorized, "missing or malformed Authorization header")
				return
			}
			u, _, err := svc.LookupSession(r.Context(), token)
			if errors.Is(err, auth.ErrSessionNotFound) || errors.Is(err, auth.ErrSessionExpired) {
				writeJSONError(w, http.StatusUnauthorized, "invalid session")
				return
			}
			if err != nil {
				slog.Error("auth middleware: session lookup failed", "error", err)
				writeJSONError(w, http.StatusInternalServerError, "internal error")
				return
			}
			ctx := context.WithValue(r.Context(), ctxUserKey, u)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Package proto defines the JSON shapes shared between the server and
// the client. Mirror these in client/src/types/ by hand — the surface
// is small enough that codegen isn't worth the complexity yet.
package proto

// LoginRequest is the body of POST /api/auth/login.
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoginResponse is returned on a successful POST /api/auth/login.
// ExpiresAt is omitted when the session has no expiry.
type LoginResponse struct {
	Token     string   `json:"token"`
	ExpiresAt string   `json:"expires_at,omitempty"`
	User      UserInfo `json:"user"`
}

// UserInfo is a public view of a user — no password hash.
type UserInfo struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	CreatedAt string `json:"created_at"`
}

// ErrorResponse is the body returned with any 4xx/5xx response.
type ErrorResponse struct {
	Error string `json:"error"`
}

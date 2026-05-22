// Package proto defines the JSON shapes shared between the server and
// the client. Mirror these in client/src/types/ by hand — the surface
// is small enough that codegen isn't worth the complexity yet.
package proto

// LoginRequest is the body of POST /api/auth/login.
//
// ClientVersion is optional and free-form — the server stores it on
// the session row so the admin dashboard can display "alice — last
// seen via web 0.18.1". Conventional values look like
// "desktop 0.18.1" or "web 0.18.1".
type LoginRequest struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	ClientVersion string `json:"client_version,omitempty"`
}

// LoginResponse is returned on a successful POST /api/auth/login.
// ExpiresAt is omitted when the session has no expiry.
type LoginResponse struct {
	Token     string   `json:"token"`
	ExpiresAt string   `json:"expires_at,omitempty"`
	User      UserInfo `json:"user"`
}

// UserInfo is a public view of a user — no password hash.
//
// DisplayName is the user's optional pretty name; empty string means
// fall back to Username in the UI. HasAvatar lets clients decide
// whether to render the avatar image (fetched from
// `GET /api/users/{id}/avatar`) or initials. AvatarVersion changes
// every time the user uploads a new avatar, so clients can append it
// to the image URL as a cache-buster — the URL path itself stays
// stable as /api/users/{id}/avatar.
type UserInfo struct {
	ID            int64  `json:"id"`
	Username      string `json:"username"`
	CreatedAt     string `json:"created_at"`
	DisplayName   string `json:"display_name,omitempty"`
	HasAvatar     bool   `json:"has_avatar,omitempty"`
	AvatarVersion int64  `json:"avatar_version,omitempty"`
}

// ErrorResponse is the body returned with any 4xx/5xx response.
type ErrorResponse struct {
	Error string `json:"error"`
}

// SetProfileRequest is the body of PUT /api/me/profile. Empty
// display_name clears the user's stored value (clients fall back to
// username).
type SetProfileRequest struct {
	DisplayName string `json:"display_name"`
}

// ListUsersResponse is the body of GET /api/users — the public
// roster every signed-in user can read. Backs the "Family" section
// of the contact list so users you haven't DM'd are still
// discoverable (otherwise an offline family member you've never
// chatted with is invisible). Deliberately narrower than the admin
// list endpoint: no IsAdmin, no LastSeenAt.
type ListUsersResponse struct {
	Users []UserInfo `json:"users"`
}

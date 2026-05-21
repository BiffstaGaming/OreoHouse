package proto

// AdminUserView is a row returned by GET /api/admin/users. Extends
// UserInfo with the fields only the admin panel needs: is_admin and
// last_seen_at. LastSeenAt is omitted when the user has never connected.
type AdminUserView struct {
	ID         int64  `json:"id"`
	Username   string `json:"username"`
	CreatedAt  string `json:"created_at"`
	IsAdmin    bool   `json:"is_admin"`
	LastSeenAt string `json:"last_seen_at,omitempty"`
}

// ListAdminUsersResponse is returned by GET /api/admin/users.
type ListAdminUsersResponse struct {
	Users []AdminUserView `json:"users"`
}

// CreateAdminUserRequest is the body of POST /api/admin/users.
type CreateAdminUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// SetAdminUserPasswordRequest is the body of PUT
// /api/admin/users/{id}/password.
type SetAdminUserPasswordRequest struct {
	Password string `json:"password"`
}

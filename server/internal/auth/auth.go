// Package auth provides password hashing, session token management,
// and user/session persistence backed by SQLite.
//
// Construct a Service with NewService and use it for CreateUser,
// Authenticate, CreateSession, LookupSession, DeleteSession, and
// ListUsers.
//
// Session tokens are 32 random bytes (crypto/rand) hex-encoded. They
// are stored plain — the threat model is a trusted home LAN where
// hashing tokens at rest doesn't earn enough to justify the lookup
// complexity. Sessions optionally expire after the TTL supplied to
// NewService; pass 0 for sessions that never expire.
package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// MinPasswordLength is the minimum required password length when
// creating a user. CLI and HTTP layers should validate before calling
// CreateUser.
const MinPasswordLength = 8

// Sentinel errors returned by Service methods.
var (
	ErrUserExists         = errors.New("user already exists")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrSessionNotFound    = errors.New("session not found")
	ErrSessionExpired     = errors.New("session expired")
	ErrInvalidUsername    = errors.New("invalid username")
	ErrPasswordTooShort   = fmt.Errorf("password must be at least %d characters", MinPasswordLength)
)

var usernameRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{2,32}$`)

// User is a row in the users table.
type User struct {
	ID        int64
	Username  string
	CreatedAt time.Time
}

// Session is a row in the sessions table. ExpiresAt is the zero value
// when the session never expires.
type Session struct {
	Token     string
	UserID    int64
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Expired reports whether the session is past its expiry as of now.
// Sessions with a zero ExpiresAt never expire.
func (s Session) Expired(now time.Time) bool {
	if s.ExpiresAt.IsZero() {
		return false
	}
	return !now.Before(s.ExpiresAt)
}

// Service is the auth-related database accessor. Construct via NewService.
type Service struct {
	db         *sql.DB
	sessionTTL time.Duration
	now        func() time.Time
}

// NewService returns a Service that reads and writes via db. sessionTTL
// is how long freshly-created sessions stay valid; pass 0 for sessions
// that never expire.
func NewService(db *sql.DB, sessionTTL time.Duration) *Service {
	return &Service{
		db:         db,
		sessionTTL: sessionTTL,
		now:        func() time.Time { return time.Now().UTC() },
	}
}

// ValidateUsername returns ErrInvalidUsername if username does not match
// the project's username rules (2-32 chars, [A-Za-z0-9_-]).
func ValidateUsername(username string) error {
	if !usernameRegex.MatchString(username) {
		return ErrInvalidUsername
	}
	return nil
}

// ValidatePassword returns ErrPasswordTooShort if password is shorter
// than MinPasswordLength runes.
func ValidatePassword(password string) error {
	if len([]rune(password)) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	return nil
}

// CreateUser inserts a new user with the given username and password.
// The password is bcrypt-hashed at DefaultCost before storage. Returns
// ErrInvalidUsername / ErrPasswordTooShort on validation failure, and
// ErrUserExists if the username is taken (case-insensitive).
func (s *Service) CreateUser(ctx context.Context, username, password string) (User, error) {
	if err := ValidateUsername(username); err != nil {
		return User{}, err
	}
	if err := ValidatePassword(password); err != nil {
		return User{}, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, fmt.Errorf("hashing password: %w", err)
	}
	now := s.now()
	res, err := s.db.ExecContext(ctx,
		"INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
		username, string(hash), formatTime(now))
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrUserExists
		}
		return User{}, fmt.Errorf("inserting user: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, fmt.Errorf("getting user id: %w", err)
	}
	return User{ID: id, Username: username, CreatedAt: now}, nil
}

// Authenticate returns the User matching username if password matches
// its stored hash. Returns ErrInvalidCredentials on either no-such-user
// or bad-password (to avoid leaking which one).
func (s *Service) Authenticate(ctx context.Context, username, password string) (User, error) {
	var (
		u            User
		passwordHash string
		createdAt    string
	)
	err := s.db.QueryRowContext(ctx,
		"SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
		username).Scan(&u.ID, &u.Username, &passwordHash, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		// Run bcrypt against a dummy hash so timing doesn't leak
		// whether the user exists.
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("looking up user: %w", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)); err != nil {
		return User{}, ErrInvalidCredentials
	}
	u.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return User{}, fmt.Errorf("parsing created_at: %w", err)
	}
	return u, nil
}

// CreateSession inserts a new session for userID. ExpiresAt is set to
// now+TTL when the service's TTL is positive, otherwise it's the zero
// time and the session never expires.
func (s *Service) CreateSession(ctx context.Context, userID int64) (Session, error) {
	token, err := newSessionToken()
	if err != nil {
		return Session{}, fmt.Errorf("generating session token: %w", err)
	}
	now := s.now()
	var (
		expiresAt    time.Time
		expiresAtArg any
	)
	if s.sessionTTL > 0 {
		expiresAt = now.Add(s.sessionTTL)
		expiresAtArg = formatTime(expiresAt)
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
		token, userID, formatTime(now), expiresAtArg); err != nil {
		return Session{}, fmt.Errorf("inserting session: %w", err)
	}
	return Session{
		Token:     token,
		UserID:    userID,
		CreatedAt: now,
		ExpiresAt: expiresAt,
	}, nil
}

// LookupSession returns the user and session associated with token.
// Returns ErrSessionNotFound if no such session exists,
// ErrSessionExpired if the session is past its expiry.
func (s *Service) LookupSession(ctx context.Context, token string) (User, Session, error) {
	var (
		sess          Session
		u             User
		createdAt     string
		expiresAt     sql.NullString
		userCreatedAt string
	)
	err := s.db.QueryRowContext(ctx, `
        SELECT s.token, s.user_id, s.created_at, s.expires_at,
               u.id,    u.username, u.created_at
          FROM sessions s
          JOIN users    u ON u.id = s.user_id
         WHERE s.token = ?
    `, token).Scan(&sess.Token, &sess.UserID, &createdAt, &expiresAt,
		&u.ID, &u.Username, &userCreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, Session{}, ErrSessionNotFound
	}
	if err != nil {
		return User{}, Session{}, fmt.Errorf("looking up session: %w", err)
	}
	sess.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return User{}, Session{}, fmt.Errorf("parsing session created_at: %w", err)
	}
	if expiresAt.Valid {
		sess.ExpiresAt, err = parseTime(expiresAt.String)
		if err != nil {
			return User{}, Session{}, fmt.Errorf("parsing session expires_at: %w", err)
		}
	}
	u.CreatedAt, err = parseTime(userCreatedAt)
	if err != nil {
		return User{}, Session{}, fmt.Errorf("parsing user created_at: %w", err)
	}
	if sess.Expired(s.now()) {
		return User{}, Session{}, ErrSessionExpired
	}
	return u, sess, nil
}

// UpdateLastSeen sets the last_seen_at column on the given user to
// at. Used by the WebSocket handler when a user's last connection
// closes.
func (s *Service) UpdateLastSeen(ctx context.Context, userID int64, at time.Time) error {
	if _, err := s.db.ExecContext(ctx,
		"UPDATE users SET last_seen_at = ? WHERE id = ?",
		formatTime(at), userID); err != nil {
		return fmt.Errorf("updating last_seen_at: %w", err)
	}
	return nil
}

// SetStatusText persists the user's custom status text. An empty
// string clears it.
func (s *Service) SetStatusText(ctx context.Context, userID int64, text string) error {
	var arg any
	if text == "" {
		arg = nil
	} else {
		arg = text
	}
	if _, err := s.db.ExecContext(ctx,
		"UPDATE users SET status_text = ? WHERE id = ?",
		arg, userID); err != nil {
		return fmt.Errorf("updating status_text: %w", err)
	}
	return nil
}

// GetStatusText returns the user's persisted custom status text, or
// "" when NULL. Returns no error and "" for unknown users.
func (s *Service) GetStatusText(ctx context.Context, userID int64) (string, error) {
	var text sql.NullString
	err := s.db.QueryRowContext(ctx,
		"SELECT status_text FROM users WHERE id = ?", userID).Scan(&text)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("querying status_text: %w", err)
	}
	if !text.Valid {
		return "", nil
	}
	return text.String, nil
}

// DeleteSession deletes the session with the given token. Returns nil
// even if no session matches (logout is idempotent).
func (s *Service) DeleteSession(ctx context.Context, token string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE token = ?", token); err != nil {
		return fmt.Errorf("deleting session: %w", err)
	}
	return nil
}

// ListUsers returns all users in the database, ordered by id.
func (s *Service) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, username, created_at FROM users ORDER BY id")
	if err != nil {
		return nil, fmt.Errorf("querying users: %w", err)
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var (
			u         User
			createdAt string
		)
		if err := rows.Scan(&u.ID, &u.Username, &createdAt); err != nil {
			return nil, fmt.Errorf("scanning user: %w", err)
		}
		t, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parsing user created_at: %w", err)
		}
		u.CreatedAt = t
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating users: %w", err)
	}
	return out, nil
}

// newSessionToken returns a fresh 32-byte hex-encoded random token.
func newSessionToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// isUniqueViolation reports whether err is a SQLite UNIQUE-constraint
// failure. Matches on the error string rather than coupling to the
// driver's typed error — there's only one driver in use.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// formatTime formats t in the ISO-8601 layout we use in TEXT columns.
// Callers normalize to UTC before calling.
func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

// parseTime parses an RFC3339Nano timestamp out of a TEXT column. All
// timestamps in the schema are written by formatTime above, so this is
// the only format we expect.
func parseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing time %q: %w", s, err)
	}
	return t.UTC(), nil
}

// dummyHash is a valid bcrypt hash that Authenticate runs against when
// the username doesn't exist, so timing doesn't leak the existence of
// a username.
var dummyHash = func() []byte {
	h, err := bcrypt.GenerateFromPassword([]byte("oreohouse-timing-pad"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}
	return h
}()

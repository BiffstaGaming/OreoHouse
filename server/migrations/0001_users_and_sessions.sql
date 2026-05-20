CREATE TABLE users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT    NOT NULL,
    created_at     TEXT    NOT NULL
);

CREATE TABLE sessions (
    token       TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL,
    expires_at  TEXT    NULL
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);

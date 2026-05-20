CREATE TABLE conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL CHECK (type IN ('dm', 'group', 'room')),
    name        TEXT    NULL,
    created_at  TEXT    NOT NULL
);

CREATE TABLE conversation_members (
    conversation_id           INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at                 TEXT    NOT NULL,
    last_delivered_message_id INTEGER NULL,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_members_user_id_idx ON conversation_members(user_id);

CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT    NOT NULL,
    created_at      TEXT    NOT NULL
);

CREATE INDEX messages_conversation_id_id_idx ON messages(conversation_id, id);

CREATE TABLE attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uploader_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id    INTEGER NULL     REFERENCES messages(id) ON DELETE CASCADE,
    filename      TEXT    NOT NULL,
    mime_type     TEXT    NOT NULL,
    size_bytes    INTEGER NOT NULL,
    image_width   INTEGER NULL,
    image_height  INTEGER NULL,
    storage_path  TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
);

CREATE INDEX attachments_message_id_idx  ON attachments(message_id);
CREATE INDEX attachments_uploader_id_idx ON attachments(uploader_id);

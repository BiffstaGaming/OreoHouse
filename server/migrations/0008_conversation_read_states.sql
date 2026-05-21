-- Phase: read receipts. One row per (conversation, user) tracking the
-- highest message id the user has acknowledged seeing in that conv.
-- Updates are monotonic on the server side (MarkConversationRead is a
-- no-op when last_read_message_id <= current).
--
-- We deliberately don't reuse conversation_members.last_delivered_message_id
-- (which is a *delivered* cursor, advanced when the server confirms a
-- message reached a connected client). Delivered ≠ read — a client can
-- be connected with the conv minimised and never look at the new
-- message. Keeping the two separate avoids confusing the replay
-- machinery.
CREATE TABLE conversation_read_states (
    conversation_id      INTEGER NOT NULL,
    user_id              INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL,
    updated_at           TEXT    NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE
);

-- Forward lookup: "every read state for the convs user X belongs to"
-- (used by the welcome handler to hydrate the client's per-conv tick
-- state). The PK already covers per-conversation lookups.
CREATE INDEX idx_conversation_read_states_user
    ON conversation_read_states (user_id);

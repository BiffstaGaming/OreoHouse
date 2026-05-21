-- Phase: emoji reactions on messages.
--
-- One row per (message, user, emoji). A single user can attach the
-- same emoji to a message at most once, but they can attach as many
-- DIFFERENT emoji to the same message as they like. The (m, u, e)
-- composite PK enforces uniqueness; the supporting index speeds up
-- the per-conversation hydration query that JOINs onto messages.
CREATE TABLE message_reactions (
    message_id INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    emoji      TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
);

CREATE INDEX idx_message_reactions_message
    ON message_reactions (message_id);

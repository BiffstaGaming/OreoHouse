-- Phase: pinned messages per conversation.
--
-- Pins are a many-to-many: each row marks one message as pinned in
-- the context of a conversation. We could derive (conversation_id)
-- from the message but storing it explicitly lets a single message
-- be theoretically pinnable in multiple conversations (e.g. after a
-- forward feature in the future), and avoids JOINing back to
-- messages on every list call.
--
-- pinned_by is informational ("Bob pinned this 5 minutes ago"). We
-- DON'T enforce admin-only-pin for the MVP — any member can pin a
-- message in their conversation.
CREATE TABLE conversation_pins (
    conversation_id INTEGER NOT NULL,
    message_id      INTEGER NOT NULL,
    pinned_by       INTEGER NOT NULL,
    pinned_at       TEXT    NOT NULL,
    PRIMARY KEY (conversation_id, message_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id)      REFERENCES messages(id)      ON DELETE CASCADE,
    FOREIGN KEY (pinned_by)       REFERENCES users(id)         ON DELETE CASCADE
);

CREATE INDEX idx_conversation_pins_conv ON conversation_pins (conversation_id);

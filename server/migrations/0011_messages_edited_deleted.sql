-- Phase: message editing + soft deletion + reply-to.
--
-- edited_at NULL  → message has never been edited.
-- edited_at set   → most recent edit timestamp; rendered as "(edited)"
--                   suffix on the client.
--
-- deleted_at NULL → message is live.
-- deleted_at set  → message was soft-deleted by its sender. The server
--                   continues to return the row in history paginations
--                   so message id sequences stay dense, but the body
--                   is suppressed to "" before going on the wire.
--
-- reply_to_id     → optional FK to messages(id) when this message
--                   quotes another. ON DELETE SET NULL so a deleted
--                   original doesn't cascade-erase replies; the
--                   client just renders "(replied to a deleted
--                   message)" in that case.
ALTER TABLE messages ADD COLUMN edited_at   TEXT    NULL;
ALTER TABLE messages ADD COLUMN deleted_at  TEXT    NULL;
ALTER TABLE messages ADD COLUMN reply_to_id INTEGER NULL
    REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_reply_to ON messages (reply_to_id);

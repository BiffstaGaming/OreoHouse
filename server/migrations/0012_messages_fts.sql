-- Phase: full-text message search.
--
-- Virtual table backed by FTS5 — ships with modernc.org/sqlite and is
-- compiled in by default. We use the contentless-by-id pattern
-- (`content='messages', content_rowid='id'`) so the FTS table doesn't
-- duplicate the body bytes; it just indexes them.
CREATE VIRTUAL TABLE messages_fts USING fts5(
    body,
    content='messages',
    content_rowid='id'
);

-- Backfill the existing rows so search works from day-one on databases
-- that pre-date this migration.
INSERT INTO messages_fts(rowid, body)
    SELECT id, body FROM messages;

-- Keep FTS in lockstep with messages via triggers. INSERT writes a new
-- index entry; DELETE uses the magic 'delete' command on the FTS
-- virtual table; UPDATE does both (so an edit shows the new content).
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body)
        VALUES ('delete', old.id, old.body);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body)
        VALUES ('delete', old.id, old.body);
    INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

-- Track which client + version a session was created from so the
-- admin dashboard can show "alice — last seen via web 0.18.0" type
-- info. Nullable because legacy rows + non-version-aware clients
-- (e.g. curl during testing) simply won't populate it.
ALTER TABLE sessions ADD COLUMN client_version TEXT NULL;

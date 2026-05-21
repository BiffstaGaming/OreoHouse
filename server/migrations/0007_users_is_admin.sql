-- Phase 8: admin panel. is_admin gates the new /api/admin/* endpoints
-- and the embedded /admin/ web UI. Defaulted to 0 so existing rows are
-- non-admins; the CLI promotes the first user added via
-- `oreohouse user add` so a fresh database always has exactly one
-- admin to start from.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

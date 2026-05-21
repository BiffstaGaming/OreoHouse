-- Phase: avatars + display names.
--
-- display_name is the optional pretty name shown everywhere the
-- username currently is in the UI (contact list, chat bubbles, etc).
-- When NULL, clients fall back to username. Bounded to 64 bytes —
-- enforced by the REST handler, not at the column level.
--
-- avatar_attachment_id points at an existing row in `attachments` that
-- the user uploaded specifically as their avatar. Reusing the
-- attachments table avoids inventing a parallel blob store; the
-- avatar download endpoint (`GET /api/users/{id}/avatar`) just
-- streams that attachment's bytes. ON DELETE SET NULL so removing the
-- attachment for any reason simply clears the user's avatar without
-- failing the user row.
ALTER TABLE users ADD COLUMN display_name TEXT NULL;
ALTER TABLE users
    ADD COLUMN avatar_attachment_id INTEGER NULL
    REFERENCES attachments(id) ON DELETE SET NULL;

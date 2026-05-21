# 0002 — Admin panel UI is vanilla HTML/CSS/JS, embedded

Date: 2026-05-21
Status: Accepted

## Context

Phase 8 ships an admin panel for user management (list users, add user, reset password). Two architectural forks had to be picked:

1. **Where does the UI live?** Browser at `/admin/` on the Go server, vs. a new tab inside the existing Tauri client.
2. **What's it built with?** A React + Vite SPA matching the desktop client's stack, vs. plain HTML + ES module JS with no build step.

The user picked browser-at-`/admin/`. This ADR records why we then went vanilla rather than React.

## Decision

**Plain HTML + ES module JS + CSS, three files, embedded into the Go binary via `embed.FS`.**

- `server/internal/api/adminui/assets/index.html` — markup for all three screens (login, dashboard, reset-password `<dialog>`).
- `server/internal/api/adminui/assets/app.js` — ~250 lines of vanilla JS that calls the existing REST API with `fetch`.
- `server/internal/api/adminui/assets/style.css` — MSN-flavored palette to match the desktop client.
- `server/internal/api/adminui/adminui.go` — `//go:embed assets/*` + a chi-friendly `http.Handler`.

No bundler, no `node_modules`, no transpilation step in CI for the admin surface.

## Consequences

**Why we picked vanilla:**

- The whole panel is three screens with five form submits. React + Vite would add a build pipeline, an npm dependency tree, and a deploy step (build, copy `dist/` into `embed`) for what amounts to plain CRUD.
- The Tauri client already has its own React build; sharing components across two webviews loaded from different origins would be more friction than reward at this scale.
- CLAUDE.md says "default to the simpler option." Vanilla is the simpler option.
- The admin surface is tiny — five endpoints, three screens — and unlikely to grow into something framework-shaped. If Phase 9+ pulls in something heavier (conversation moderation, attachment management, log viewer), we can revisit; nothing in this design blocks a future switch.

**Trade-offs accepted:**

- Two different patterns in the codebase (React for the client, vanilla for `/admin/`). Worth it for the build-step savings on the admin side.
- No TypeScript on the admin UI. The surface is small enough that runtime testing + the JSON shapes in `proto/admin.go` are enough discipline.
- `<dialog>` element used for the reset-password modal; not supported in very old browsers. Fine — the admin will be using a recent Chromium-based browser to reach the LAN-only server.

## How to extend

To add a new admin endpoint:

1. Add the proto type to `server/internal/proto/admin.go`.
2. Add the handler method to `server/internal/api/admin.go` and route it in `Mount`.
3. Add the UI in `index.html`, wire it in `app.js` with the existing `api()` helper.

No build step, no asset hashing, no cache busting needed — the `embed.FS` baked into the binary changes every build anyway.

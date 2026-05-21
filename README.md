# OreoHouse

A self-hosted family LAN messenger inspired by old-school clients like MSN Messenger and BeeBEEP — the contact list is the main UI, chat happens in popup windows, presence shows as little dots, and you can nudge someone to shake their window. One Docker container on the home server, a Go backend over WebSockets, and a Tauri + React desktop client.

## Status

Phase 8 — admin panel landed. The server now ships a tiny embedded web UI at `http://server:8080/admin/` for user management: log in as an admin, see the user list with last-seen timestamps, add new users, and reset any user's password. The first user added via `oreohouse user add` on a fresh install is auto-promoted to admin; further promotions / demotions happen via the new `oreohouse user promote` / `user demote` CLI commands. The page is plain HTML + ES module JS + CSS, no build step (see [ADR 0002](docs/decisions/0002-admin-ui-vanilla-html.md)). See [CLAUDE.md](CLAUDE.md) for the project mission and roadmap, [`docs/protocol.md`](docs/protocol.md) for the WebSocket wire protocol, and [`docs/decisions/`](docs/decisions/) for architecture decisions.

## Downloads

| What | Where | Version |
|------|-------|---------|
| Windows client (`.msi` and NSIS `.exe`) | [Releases](https://github.com/BiffstaGaming/OreoHouse/releases) | latest release |
| Server container image | `ghcr.io/biffstagaming/oreohouse:latest` ([Packages](https://github.com/BiffstaGaming/OreoHouse/pkgs/container/oreohouse)) | `latest`, `main`, `vX.Y.Z`, `sha-<short>` |

Both are produced by GitHub Actions on every tagged release — see [Versioning & releases](#versioning--releases) below.

## Prerequisites

- **Go** 1.25+ (the module pins it because of `modernc.org/sqlite`'s floor; CLAUDE.md still lists 1.22+ as the project target)
- **Node** 20+ and **npm**
- **Rust** stable (rustup) — Tauri builds the desktop shell
- **MSVC C++ Build Tools** on Windows (Rust's linker)
- **WebView2 runtime** on Windows clients (preinstalled on recent Windows 10/11)
- **Docker** Desktop (for the containerized server)

## Layout

```
server/   Go binary, SQLite, WebSocket hub, REST API
client/   Tauri v2 + React + TypeScript desktop app
docs/     ADRs and protocol/schema specs (filled in over later phases)
```

## Server (dev)

```bash
cd server
go run ./cmd/oreohouse serve
```

Defaults: HTTP on `:8080`, data dir `./data`. The SQLite file is created at `<data_dir>/oreohouse.db` on first run.

Override via env vars or flags:

| Env var                       | Flag                  | Default  | Notes                                            |
|-------------------------------|-----------------------|----------|--------------------------------------------------|
| `OREOHOUSE_ADDR`              | `--addr`              | `:8080`  | HTTP listen address                              |
| `OREOHOUSE_DATA_DIR`          | `--data-dir`          | `./data` | SQLite file + uploads dir                        |
| `OREOHOUSE_SESSION_TTL_DAYS`  | `--session-ttl-days`  | `0`      | Session token lifetime in days; `0` = never expire |
| `OREOHOUSE_MAX_UPLOAD_MB`     | `--max-upload-mb`     | `25`     | Per-upload size cap in MiB                       |

Endpoints:

- `GET /health` → `{"status":"ok"}`
- `GET /ws?token=<session>` → WebSocket; requires a valid session token. See [WebSocket](#websocket) below and [`docs/protocol.md`](docs/protocol.md) for the message catalog.
- `POST /api/auth/login` → see [Authentication](#authentication) below.
- `POST /api/auth/logout` → idempotent, deletes the session.
- `GET /api/conversations` → list conversations the caller is a member of (Bearer token required).
- `POST /api/conversations/dm` → find-or-create a DM with `{ "user_id": N }`.
- `POST /api/conversations/group` → create a group with `{ "name"?: "...", "member_ids": [N, M, ...] }`. Creator is always included.
- `POST /api/conversations/room` → create a room with `{ "name": "...", "topic"?: "..." }`. Creator becomes the sole initial member.
- `POST /api/conversations/{id}/members` → add `{ "user_ids": [...] }` to a group. Caller must be a member; rooms reject (use `/api/rooms/{id}/join`).
- `POST /api/conversations/{id}/leave` → self-leave any non-DM conversation. DMs return 400.
- `GET /api/conversations/{id}/messages?before=<id>&limit=<n>` → cursor-paginated history, newest first. Caller must be a member of the conversation; non-members get 404.
- `GET /api/rooms` → list every room in the system with member counts, newest first.
- `POST /api/rooms/{id}/join` → self-join a room. Idempotent.
- `POST /api/uploads` → multipart/form-data with a single `file` part. Returns the new `AttachmentView`. Capped at `OREOHOUSE_MAX_UPLOAD_MB`. Bearer auth required.
- `GET /api/files/{id}` → stream the bytes. Accepts either `Authorization: Bearer ...` or `?token=...` query (so `<img src>` works). Caller must be the uploader (covers orphan uploads) or a member of the conversation the attachment is linked to; otherwise 404.
- `GET /api/admin/users` / `POST /api/admin/users` / `PUT /api/admin/users/{id}/password` → admin-only user management. Behind a Bearer-token check **plus** an `is_admin` gate (non-admin callers get 403 `"admin required"`). Powers the embedded panel at `/admin/`; see [Admin panel](#admin-panel) below.
- `GET /admin/` → embedded HTML + JS web UI for the admin endpoints above. Login uses the same `/api/auth/login` flow as the desktop client; the page hides itself from non-admins.

## Authentication

Accounts are pre-provisioned by the admin via [user management](#user-management); there is no self-signup.

**Login:**

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter"}'
```

Response on success (HTTP 200):

```json
{
  "token": "7634928ace…a8",
  "expires_at": "2026-06-20T12:00:00Z",
  "user": { "id": 1, "username": "alice", "created_at": "2026-05-20T21:43:25.41Z" }
}
```

`expires_at` is omitted when `OREOHOUSE_SESSION_TTL_DAYS=0`. The token goes in `Authorization: Bearer <token>` on later authenticated requests.

Bad credentials and unknown usernames both return HTTP 401 with `{"error":"invalid credentials"}` so a caller can't enumerate accounts.

**Logout:**

```bash
curl -X POST http://localhost:8080/api/auth/logout \
  -H "Authorization: Bearer <token>"
```

Returns 204 even if the token doesn't match a live session — logout is idempotent.

## WebSocket

After login, the client opens a single WebSocket to `ws://host:8080/ws?token=<token>`. The token comes from `POST /api/auth/login`. Missing or invalid tokens are rejected with HTTP 401 *before* the upgrade — there is no in-band auth error.

Presence is derived from connection state plus a per-user discrete state and an optional custom text line:

- A user "comes online" when their **first** connection opens. The server broadcasts `presence` with `state="online"` to every connected client.
- A user "goes offline" when their **last** connection closes (so two laptops + a phone count as one online user). `presence` with `state="offline"` is broadcast and `users.last_seen_at` is updated.
- Immediately after a successful upgrade the server sends a `welcome` message with a snapshot of who's currently online — each entry carries `state` (`online` / `away` / `busy`) and an optional `custom_text` — so the client doesn't poll.
- A client can send `status` to change its discrete state to `online` / `away` / `busy` and/or set a `custom_text` line (e.g. "in a meeting"). The text is persisted to `users.status_text` so it survives reconnects; discrete state is session-only and defaults to `online` on each fresh connection. The server validates and broadcasts a `presence` event with the new state + text to every online client.

Messaging:

- Client posts `{"type":"message","conversation_id":N,"body":"..."}` over the WS. The server validates membership and the 4 KB body cap, persists, and broadcasts a server-side `message` envelope (with the assigned `id`, `sender`, and `created_at`) to every member of the conversation — including the sender, so all UIs add the row through one path.
- On reconnect, after `welcome`, the server replays any messages whose `id` is greater than the receiver's per-conversation `last_delivered_message_id` cursor (advanced as live deliveries succeed). Replay completes before live messages start streaming, so order is preserved.

Membership events:

- `conversation_added` is pushed to a user the moment they're added to a new conversation (group create, group invite, room join). It carries the full conversation view so the client can drop it straight into its list.
- `conversation_members_changed` is pushed to the *existing* members of a conversation when its membership changes; it carries the new full member list. The change-target (the joiner / new invitee) gets `conversation_added` instead, not a parallel members-changed event.

Attachments:

- Two-step send. Client first POSTs each file to `/api/uploads` (returns an `AttachmentView` with id + metadata + image dimensions when applicable). Then it sends a normal WS `message` with `attachment_ids: [N, …]`. Server validates that the sender owns each id and that none are already linked, then persists the message and links them atomically (from the user's perspective) before broadcasting the `message` event with the full `attachments[]` inlined.
- Images render inline in the client; other files render as a download chip. The image source URL carries `?token=` because `<img src>` can't set an Authorization header.

Full message catalog (welcome, presence, message, conversation_added, conversation_members_changed, typing, nudge, status, error, ping, pong) lives in [`docs/protocol.md`](docs/protocol.md). The TypeScript mirror is at [`client/src/types/proto.ts`](client/src/types/proto.ts).

## User management

Account provisioning happens via the same `oreohouse` binary, against the same SQLite file the server uses (set `OREOHOUSE_DATA_DIR` to point at it).

```bash
# Interactive: prompts for password, hides input, confirms.
oreohouse user add --username alice

# Scriptable: read password from stdin.
echo 'hunter2hunter' | oreohouse user add --username alice --password-stdin

# List all users (shows an ADMIN column).
oreohouse user list

# Mark a user as admin (idempotent; refuses to demote the last admin).
oreohouse user promote --username alice
oreohouse user demote  --username alice
```

The **first** user added to a fresh database is auto-promoted to admin so there's always one bootstrap account. Subsequent users default to non-admin; promote them with the panel or the CLI.

Constraints enforced by the CLI and server:

- Username: 2–32 characters, `[A-Za-z0-9_-]`, case-insensitive uniqueness.
- Password: 8 characters minimum (bcrypt-hashed at cost 10 before storage).

There is no `--password` flag — argv leaks to shell history and `ps`. Use the prompt or `--password-stdin`.

Running these inside the running Docker container:

```bash
docker exec -it oreohouse /app/oreohouse user list
```

## Admin panel

The server hosts a tiny web UI at `http://<server>:8080/admin/` for user management. Open it from any browser on the LAN — no Tauri install needed.

- **Sign in** with any user account; only `is_admin` users get past the dashboard probe (non-admins see "That account isn't an admin." and bounce back to the login form).
- **Users table** lists every account with `id`, `username`, admin badge, `created_at`, and `last_seen_at` (blank for users who have never connected).
- **Add user** form creates a new non-admin user. To promote them, run `oreohouse user promote --username X` from the CLI (the panel deliberately doesn't expose role toggles — see [ADR 0002](docs/decisions/0002-admin-ui-vanilla-html.md)).
- **Reset password** opens a small modal that PUTs to `/api/admin/users/{id}/password`. Existing sessions for that user are NOT revoked; if you want them logged out, restart the server or wait for the session TTL (or delete the row from `sessions` manually — there's no panel control for this yet).
- **Sign out** clears the token from `localStorage` and calls `/api/auth/logout`.

The page itself is three files (`index.html`, `app.js`, `style.css`) baked into the Go binary via `embed.FS`; there is no separate build step or static-files volume to mount.

## Client (dev)

```bash
cd client
npm install
npm run tauri dev
```

First-time `tauri dev` compiles the Rust shell (a few minutes), then opens a native window. Subsequent runs are quick.

The Phase 0 UI is a smoke tester: type a server URL (default `http://localhost:8080`), click **Connect**, drop JSON in the textarea, click **Send**, and the echoed message lands in the log below. `http(s)://host:port` is auto-converted to `ws(s)://host:port/ws`.

## Docker (server)

Build and run the server container from the repo root:

```bash
docker compose up -d --build
```

This builds `oreohouse:dev` from the multi-stage `Dockerfile` (`golang:1.25-alpine` builder → `gcr.io/distroless/static-debian12`), exposes `:8080`, and bind-mounts `./data` on the host to `/data` in the container so the SQLite file persists.

Tail logs:

```bash
docker compose logs -f
```

Stop and clean up:

```bash
docker compose down
```

## Published image (GHCR)

Every push to `main` and every `v*` tag triggers [`.github/workflows/build-server-image.yml`](.github/workflows/build-server-image.yml), which builds the multi-stage `Dockerfile` and pushes to `ghcr.io/biffstagaming/oreohouse`.

Tags produced:

- `latest` and `main` on every push to `main`
- `vX.Y.Z` plus the SemVer-derived `X.Y` and `X.Y.Z` on `v*` tag pushes
- `sha-<short>` on every successful build, for exact pinning

The package inherits visibility from this (private) repo by default. To pull from your home server you have two choices:

1. **Make the package public.** On github.com: this repo → Packages → `oreohouse` → Package settings → Change visibility → Public. After that, anyone (including Portainer with no auth) can `docker pull`.
2. **Keep it private + authenticate.** Generate a PAT with `read:packages` scope (github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token). Then in Portainer: Registries → Add registry → Custom registry, URL `ghcr.io`, username = your GitHub username, password = the PAT. Portainer will use those creds for every `ghcr.io/...` pull.

## Desktop UX

The packaged desktop app behaves like MSN Messenger / BeeBEEP:

- **Contact list** is the home view (centred, max 28 rem). Online people, offline DM partners, and groups/rooms appear as separate sections with per-conversation unread badges.
- **Chat windows** open as floating cards layered above the contact list. Drag the title bar to move; click anywhere to bring to front; the minimize button collapses to a taskbar-style row along the bottom; the close button removes the window entirely (history is preserved in the DB). Multiple chats can be open at once; the Phase 6 windows are CSS-positioned within the single Tauri window (native multi-window can land in Phase 10 polish).
- **System tray** is wired by the Tauri shell: left-click toggles the main window, right-click opens a Show / Quit menu, and the window's [X] button hides to tray rather than exiting. Quit is only reachable via the tray menu, so the app keeps receiving WebSocket events in the background.
- **Notifications** are connection-state driven, no native push needed. A message in any conversation other than the focused front window bumps that conv's unread badge; if the main window is unfocused or hidden, the app also asks the OS for user attention (Windows taskbar flash, macOS dock bounce). The taskbar window title is prefixed with `(N)` for the total unread count.
- **Presence & status** mirror Messenger. The topbar dropdown picks between **Online**, **Away**, and **Busy**, with an optional free-text status line (e.g. "in a meeting"). Custom text persists across sessions (server-side `users.status_text` column); discrete state defaults to online on each connection. Contact rows render a green / yellow / red radial-gradient dot plus their custom text.
- **Typing indicators** appear under the chat composer ("Alice is typing…") and time out after 5 s of silence. Senders throttle to one typing event per 2 s to keep the wire quiet.
- **Nudges** are a 👋 button in each chat-window title bar. The recipient's window shakes for ~700 ms, plays a low rumble, restores from minimized if needed, and flashes the taskbar. Senders see a 3 s cooldown on the button to avoid spam.
- **Sounds** are synthesised on demand via the Web Audio API — a short blip on incoming chat messages, a low square-wave rumble on nudges. The 🔊 / 🔇 toggle in the topbar persists per-machine in `localStorage`; no audio assets are bundled (Phase 10 polish can swap in real samples).
- **Look & feel** got an MSN palette pass: blue gradient title bars on the chat windows and topbar, beveled white-to-blue buttons, radial-gradient status dots, and blue-bubbled own messages. Segoe UI as the primary font, with dark-mode variants of every gradient.

## Windows client releases

Pushing a `v*` tag also triggers [`.github/workflows/build-windows-app.yml`](.github/workflows/build-windows-app.yml), which runs on a Windows runner, builds the Tauri MSI + NSIS installers, and attaches them to a GitHub Release named after the tag. The latest release is shown in the sidebar on the repo's main page; the full list is at [Releases](https://github.com/BiffstaGaming/OreoHouse/releases).

The installers aren't code-signed (hobby project, no cert). On first launch Windows SmartScreen will warn — click **More info → Run anyway**, or right-click the downloaded file → Properties → Unblock before opening.

## Versioning & releases

Versioning is automated by [`release-please`](https://github.com/googleapis/release-please-action) driven by [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc. — already in use here).

**The flow:**

1. Each push to `main` runs [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml).
2. Release-please reads conventional commits since the last release, computes the next version (pre-1.0: `feat:` bumps the minor, `fix:` bumps the patch — major bumps are gated until a manual 1.0.0 release), and opens (or updates) a "release PR" titled `chore(main): release X.Y.Z`. The PR contains the version bump for `client/package.json`, `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.toml`, and a generated `CHANGELOG.md`.
3. Merging that PR pushes the new tag `vX.Y.Z` and creates a corresponding GitHub Release.
4. The new tag triggers [`build-server-image.yml`](.github/workflows/build-server-image.yml) (pushing `ghcr.io/biffstagaming/oreohouse:vX.Y.Z` and `:latest`) and [`build-windows-app.yml`](.github/workflows/build-windows-app.yml) (attaching the MSI + NSIS installers to the Release).

The current state of the next release lives at any time in the open release PR — review it like any other PR.

If you ever need to cut a release outside the automation, you can push a tag directly:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Tag pushes hit the same downstream workflows; `release-please` will pick up where you left off on the next push.

## Deploying with Portainer

Once the package is reachable, paste [`deploy/portainer-stack.yml`](deploy/portainer-stack.yml) into Portainer → Stacks → Add stack → Web editor. It pulls `:latest`, exposes `:8080`, persists `/data` in a Docker-managed named volume, and restarts unless stopped.

To upgrade after a new image is published: Portainer → Stacks → `oreohouse` → Editor → "Pull and redeploy".

## Pointing the client at the server

The client's **Server URL** field is what governs the connection — change it to the host running the server. Examples:

- Local dev: `http://localhost:8080`
- Other PC on the LAN: `http://192.168.1.42:8080` (replace with whatever `ipconfig` / `ip addr` reports for the server machine)
- Server-on-the-R720xd (once deployed): `http://<server-hostname-or-ip>:8080`

The client converts the HTTP origin to `ws://…/ws` automatically; you don't need to type the WebSocket URL.

## Tests

```bash
cd server
go test ./...
```

Phase 5 brings the count to ~140 tests across `db`, `auth`, `admin`, `api`, `proto`, `ws`, `conversations`, `messages`, and `attachments`. New `internal/*` packages should follow the same pattern. WebSocket handler tests use `httptest.NewServer` plus `coder/websocket` dials for full-stack coverage.

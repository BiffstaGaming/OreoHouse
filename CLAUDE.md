# OreoHouse — Family LAN Messenger

## Project mission

Self-hosted chat app for a family on the home LAN. The feel of old-school messengers — MSN Messenger, BeeBEEP — where the **contact list is the main UI**, chat happens in popup windows, presence is shown with little dots, and you can nudge someone to shake their window. Backed by a real server (single Docker container on the home R720xd) so message history is centralized and messages queue when recipients are offline.

This is a hobby/learning project for a small trusted user base (~5 family members). Optimize for **clarity and simplicity** over scalability, federation, or extensibility for unknown future use cases.

## Tech stack

- **Server**: Go 1.22+, single static binary
- **Database**: SQLite via `modernc.org/sqlite` (pure Go, no CGO — makes cross-compilation trivial)
- **WebSocket library**: `github.com/coder/websocket`
- **HTTP router**: `github.com/go-chi/chi/v5`
- **Logging**: `log/slog` (stdlib)
- **Password hashing**: `golang.org/x/crypto/bcrypt`
- **Client**: Tauri v2 (Rust shell + native WebView)
- **Frontend**: React + TypeScript + Vite inside Tauri
- **File storage**: plain filesystem, mounted as a Docker volume

## Architecture

One Docker container on the home server holds the Go binary plus its SQLite file and the uploads volume. Internal logical components:

- **WebSocket hub** (`/ws`) — real-time messages, presence, typing, nudges
- **REST API** (`/api/*`) — auth/login, file upload/download, history pagination, admin
- **SQLite database** — users, conversations, messages, members, sessions
- **File volume** — uploaded photos and attachments

Clients connect to a single endpoint over the LAN. No federation, no E2EE, no external dependencies. If external access is ever needed, it's via Tailscale or WireGuard — never by exposing the server publicly.

## Key design decisions (and why)

### Identity & auth

- **Per-user accounts**, not per-machine. Users log in from any PC, history follows them.
- **No email, no SMTP, no invite codes for MVP**. The admin creates accounts directly via a CLI command (`oreohouse user add`) or admin HTTP endpoint. For 5 family members this happens 5 times ever.
- **Password auth** with bcrypt. Session tokens are opaque random strings stored server-side in a `sessions` table — simpler than JWT and lets us revoke.

### Encryption

- **No E2EE**. The threat model doesn't justify it — the server is in the user's house. E2EE primarily defends against a compromised server and triples protocol complexity (key exchange, device verification, key backup, recovery).
- **No TLS on the LAN by default**. Plain HTTP/WS. If we ever want remote access, that's a VPN-layer problem, not an app-layer problem.
- **Passwords hashed at rest**. Message content stored in plain text in SQLite (it's a family server in a house).

### Conversation model

Unified `conversations` table with a `type` discriminator:

| Type    | Members | Name?           | Created                         | UX                                     |
|---------|---------|-----------------|---------------------------------|----------------------------------------|
| `dm`    | exactly 2 | no              | auto on first message           | shows the other person's name          |
| `group` | N       | optional        | ad-hoc from contact list        | shows member list if no name           |
| `room`  | N       | required + topic | explicitly created, joinable    | persistent "place" like a Slack channel |

Same schema, three UI flavors. Internally `group` and `room` are almost the same thing — `room` is just a `group` with a required name and a `joinable` flag.

### Wire protocol

Custom JSON over WebSocket for real-time events. REST/HTTP for files, history pagination, and auth. Rationale: family scale doesn't benefit from XMPP/Matrix, and going custom lets us add quirky message types (nudges, custom statuses) without standards-wrangling.

See `docs/protocol.md` for the full message catalog.

## Repository structure

```
OreoHouse/
├── CLAUDE.md
├── README.md
├── docker-compose.yml
├── Dockerfile
├── .gitignore
├── server/
│   ├── cmd/
│   │   └── oreohouse/
│   │       └── main.go
│   ├── internal/
│   │   ├── api/          # REST handlers
│   │   ├── ws/           # WebSocket hub
│   │   ├── db/           # SQLite access + migrations
│   │   ├── auth/         # password hashing, sessions
│   │   ├── store/        # file storage
│   │   ├── proto/        # shared message types (JSON shapes)
│   │   └── admin/        # CLI subcommands (user add, etc.)
│   ├── migrations/       # *.sql files, embedded via embed.FS
│   ├── go.mod
│   └── go.sum
├── client/
│   ├── src-tauri/        # Rust Tauri shell
│   │   ├── src/
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   ├── src/              # React + TypeScript frontend
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── lib/          # ws client, api client
│   │   ├── types/        # mirror server/internal/proto
│   │   └── App.tsx
│   ├── package.json
│   └── vite.config.ts
└── docs/
    ├── protocol.md       # wire protocol spec
    ├── schema.md         # DB schema
    └── decisions/        # ADRs as we go
```

## Coding conventions

### Go

- `gofmt` / `goimports` enforced
- Errors wrapped: `fmt.Errorf("doing thing: %w", err)`
- `internal/` for non-exported packages, `cmd/` for entry points
- No package-level mutable state; dependencies passed via struct fields (constructor-injection style)
- Every handler/method that does I/O takes `ctx context.Context` as first arg
- Migrations are SQL files in `server/migrations/`, embedded via `embed.FS` and applied at startup
- Prefer the standard library; pull a dependency only when the win is clear

### Frontend

- TypeScript strict mode, no `any` without comment
- One component per file, named export matching filename
- Shared types live in `client/src/types/` and are kept in lockstep with `server/internal/proto/` by hand (small enough surface to not need codegen yet)
- Styling: plain CSS modules or Tailwind — decide in Phase 6 when we start the real UI

### Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:` — release-please reads these to compute the next semver bump.
- One logical change per commit.
- Release tags (`vX.Y.Z`) are created by release-please when its release PR is merged. Manual phase tags (`phase-1`, `phase-2`, ...) are informational milestone markers and do NOT trigger build/release workflows.

## Testing

- Go: standard `testing` package, table-driven where it fits
- WebSocket hub: in-memory tests via `httptest.NewServer`
- Frontend: light tests, focus on protocol/state logic, not visual rendering
- Aim for tests on every public function in the server `internal/` packages

## Build & run

### Server (dev)

```bash
cd server
go run ./cmd/oreohouse serve
```

Default: HTTP on `:8080`, data dir `./data` (SQLite file + uploads).

### Admin CLI

```bash
go run ./cmd/oreohouse user add --username mom --password ...
go run ./cmd/oreohouse user list
```

### Client (dev)

```bash
cd client
npm install
npm run tauri dev
```

### Docker (prod)

```bash
docker compose up -d
```

Server container exposes `:8080`. Volume `./data` mounted at `/data` inside the container.

## Roadmap

- [x] **Phase 0** — Scaffold: repo layout, hello-world Go server with `/health` and an echo `/ws`, hello-world Tauri client that connects and echoes.
- [x] **Phase 1** — Auth: users table, password hashing, sessions, `POST /api/auth/login` + `/api/auth/logout`, `oreohouse user add` / `user list` CLI.
- [x] **Phase 2** — WebSocket hub: authenticated `/ws?token=`, in-memory connection registry, online/offline presence broadcasts (away is deferred to Phase 7), `last_seen_at` on disconnect, client login + presence list.
- [x] **Phase 3** — Messaging: conversations + messages tables, `POST /api/conversations/dm` find-or-create, REST history (`GET /api/conversations[/{id}/messages]`), `message` events over WS in both directions with replay-on-reconnect from a per-member delivery cursor, side-by-side client UI (presence + chat pane with composer).
- [x] **Phase 4** — Groups and rooms: `topic` column on conversations, REST endpoints for create/invite/leave/list-rooms/join-room, `conversation_added` + `conversation_members_changed` WS events, client UI with + Group / + Room / Browse Rooms actions and a Leave button on non-DMs.
- [x] **Phase 5** — File and photo uploads: `attachments` table + filesystem store with random storage paths, `POST /api/uploads` (Bearer) + `GET /api/files/{id}` (header or ?token=), WS `message` carries `attachment_ids[]` in + `attachments[]` out with server-side image dimension extraction (jpeg/png/gif/webp), client composer paperclip + chips + inline image previews and download chips for other files.
- [x] **Phase 6** — Real UI: contact list (online / offline DM partners / groups & rooms) as the primary view, floating CSS-positioned chat windows (drag / minimize / close / z-index focus) with a taskbar-style minimized row, Tauri system tray (Show / Quit menu, left-click toggle, close-to-tray via WindowEvent::CloseRequested intercept), unread badges per conversation, `requestUserAttention` taskbar flash for background messages, `(N) OreoHouse` window title for total unread.
- [ ] **Phase 7** — Old-school feel: nudges (window shake), typing indicators, message sounds, custom status messages
- [ ] **Phase 8** — Admin panel: simple web UI for user management
- [ ] **Phase 9** — Dockerize and deploy to the R720xd
- [ ] **Phase 10** — Polish: auto-update, install experience, icons, sounds

Stretch (post-MVP): voice messages, screen sharing, themes/skin packs (BeeBEEP-style), Linux/macOS client builds.

## Notes for Claude

- This is a hobby project. **Optimize for clarity over cleverness.** Boring code is great code here.
- **Don't add features I haven't asked for.** Stay focused on the current phase.
- When facing a design fork, **default to the simpler option**. We can add complexity later if needed.
- **Ask clarifying questions before architectural decisions** (anything that affects multiple files, the schema, or the protocol). Don't ask before small implementation choices — just make a reasonable call and note it in the commit message.
- After completing a phase or a sizeable chunk, **summarize what you did in one or two sentences and stop**. Don't auto-roll into the next phase.
- If you discover something in the codebase that contradicts this CLAUDE.md, **flag it** rather than silently working around it. The doc should be updated.
- Prefer **many small commits** over one giant one. Each commit should leave the tree in a runnable state.
- When you add a non-obvious dependency or pattern, drop a short ADR in `docs/decisions/` (`NNNN-short-title.md`).

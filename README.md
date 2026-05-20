# OreoHouse

A self-hosted family LAN messenger inspired by old-school clients like MSN Messenger and BeeBEEP — the contact list is the main UI, chat happens in popup windows, presence shows as little dots, and you can nudge someone to shake their window. One Docker container on the home server, a Go backend over WebSockets, and a Tauri + React desktop client.

## Status

Phase 3 — direct messages landed. Conversations live in SQLite (DMs auto-created on first interaction), messages are persisted with monotonic IDs, the WebSocket carries `message` events both ways with replay-on-reconnect for anything you missed while offline, and REST endpoints expose conversation list + cursor-paginated history. The client is now a real (if minimal) chat app: presence on the left, conversation thread on the right, composer + Enter to send. See [CLAUDE.md](CLAUDE.md) for the project mission and roadmap, [`docs/protocol.md`](docs/protocol.md) for the WebSocket wire protocol, and [`docs/decisions/`](docs/decisions/) for architecture decisions.

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

Endpoints:

- `GET /health` → `{"status":"ok"}`
- `GET /ws?token=<session>` → WebSocket; requires a valid session token. See [WebSocket](#websocket) below and [`docs/protocol.md`](docs/protocol.md) for the message catalog.
- `POST /api/auth/login` → see [Authentication](#authentication) below.
- `POST /api/auth/logout` → idempotent, deletes the session.
- `GET /api/conversations` → list conversations the caller is a member of (Bearer token required).
- `POST /api/conversations/dm` → find-or-create a DM with `{ "user_id": N }`.
- `GET /api/conversations/{id}/messages?before=<id>&limit=<n>` → cursor-paginated history, newest first. Caller must be a member of the conversation; non-members get 404.

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

Presence is derived from connection state:

- A user "comes online" when their **first** connection opens. The server broadcasts `presence` with `status="online"` to every connected client.
- A user "goes offline" when their **last** connection closes (so two laptops + a phone count as one online user). `presence` with `status="offline"` is broadcast and `users.last_seen_at` is updated.
- Immediately after a successful upgrade the server sends a `welcome` message with a snapshot of who's currently online, so the client doesn't poll.

Messaging:

- Client posts `{"type":"message","conversation_id":N,"body":"..."}` over the WS. The server validates membership and the 4 KB body cap, persists, and broadcasts a server-side `message` envelope (with the assigned `id`, `sender`, and `created_at`) to every member of the conversation — including the sender, so all UIs add the row through one path.
- On reconnect, after `welcome`, the server replays any messages whose `id` is greater than the receiver's per-conversation `last_delivered_message_id` cursor (advanced as live deliveries succeed). Replay completes before live messages start streaming, so order is preserved.

Full message catalog (welcome, presence, message, error, ping, pong) plus reserved future types lives in [`docs/protocol.md`](docs/protocol.md). The TypeScript mirror is at [`client/src/types/proto.ts`](client/src/types/proto.ts).

## User management

Account provisioning happens via the same `oreohouse` binary, against the same SQLite file the server uses (set `OREOHOUSE_DATA_DIR` to point at it).

```bash
# Interactive: prompts for password, hides input, confirms.
oreohouse user add --username alice

# Scriptable: read password from stdin.
echo 'hunter2hunter' | oreohouse user add --username alice --password-stdin

# List all users.
oreohouse user list
```

Constraints enforced by the CLI and server:

- Username: 2–32 characters, `[A-Za-z0-9_-]`, case-insensitive uniqueness.
- Password: 8 characters minimum (bcrypt-hashed at cost 10 before storage).

There is no `--password` flag — argv leaks to shell history and `ps`. Use the prompt or `--password-stdin`.

Running these inside the running Docker container:

```bash
docker exec -it oreohouse /app/oreohouse user list
```

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

Phase 3 brings the count to ~100 tests across `db`, `auth`, `admin`, `api`, `proto`, `ws`, `conversations`, and `messages`. New `internal/*` packages should follow the same pattern. WebSocket handler tests use `httptest.NewServer` plus `coder/websocket` dials for full-stack coverage.

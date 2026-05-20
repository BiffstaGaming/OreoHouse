# 0001 — Initial stack

Date: 2026-05-21
Status: Accepted

## Context

OreoHouse is a hobby self-hosted family LAN messenger for ~5 trusted users. We need a server, a desktop client, and a way to persist data — but no federation, no E2EE, and no scaling concerns. The whole thing lives on a home server (R720xd) behind the LAN.

## Decision

**Server:** Go 1.22+, single static binary.

- `github.com/coder/websocket` for WebSocket transport.
- `github.com/go-chi/chi/v5` for HTTP routing.
- `modernc.org/sqlite` (pure-Go SQLite) for storage — avoids CGO so cross-compilation and the distroless Docker image stay trivial.
- `log/slog` for structured logging.
- `golang.org/x/crypto/bcrypt` for password hashing (Phase 1+).

**Client:** Tauri v2 with a React + TypeScript + Vite frontend. Native shell + WebView gives us cross-platform builds and small binaries without bundling Chromium.

**Database:** SQLite, single file, mounted on a Docker volume. No separate DB server.

**File storage:** Plain filesystem, also a mounted Docker volume.

**Deployment:** One Docker container on the home R720xd. Multi-stage build, distroless final image.

## Consequences

- No CGO ⇒ static Go binary ⇒ `gcr.io/distroless/static-debian12` works as the final image.
- One SQLite file means dead-simple backups (`cp oreohouse.db backup.db`) and trivial restore.
- Tauri on Windows needs the WebView2 runtime; it's preinstalled on the Windows versions we target.
- No E2EE and no TLS by default — fine because the threat model is a trusted LAN. If remote access is ever needed, that becomes a VPN-layer problem (Tailscale/WireGuard), not an app-layer one.
- Family scale (≤10 users) means we can ignore horizontal scaling, sharding, and message queues entirely.

## Alternatives considered

- **XMPP / Matrix:** Battle-tested, but the protocol complexity and operational burden don't fit a 5-person family. Federation and E2EE solve problems we don't have.
- **Electron client:** Heavier installer, bigger memory footprint, and slower startup than Tauri.
- **Postgres / MySQL:** Overkill for a single-host hobby app. SQLite is faster for our access patterns and dramatically simpler to operate.
- **gRPC over HTTP/2:** Adds codegen tooling and Protobuf maintenance for no real win at this scale. JSON over WebSocket is easy to debug from browser devtools.

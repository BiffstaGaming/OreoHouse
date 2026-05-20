# OreoHouse

A self-hosted family LAN messenger inspired by old-school clients like MSN Messenger and BeeBEEP — the contact list is the main UI, chat happens in popup windows, presence shows as little dots, and you can nudge someone to shake their window. One Docker container on the home server, a Go backend over WebSockets, and a Tauri + React desktop client.

## Status

Phase 0 — scaffolding. See [CLAUDE.md](CLAUDE.md) for the project mission, architecture, and roadmap.

## Dev quickstart

Server:

```bash
cd server
go run ./cmd/oreohouse serve
```

Client:

```bash
cd client
npm install
npm run tauri dev
```

The full dev workflow (including Docker) lands at the end of Phase 0.

## Decisions

Architecture decisions live in [`docs/decisions/`](docs/decisions/).

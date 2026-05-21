# OreoHouse — PHP web client

A browser-based chat client for OreoHouse, intended for **guest computers
that can't (or don't want to) install the desktop app**. Same accounts,
same server, same conversations — just hosted in any modern browser on
your LAN.

This client is in PHP because that's what the user asked for, but
honestly it's mostly a static SPA. PHP only handles three things:

1. **Login form** — accepts username/password, calls the Go server's
   `POST /api/auth/login`, stashes the bearer token in `$_SESSION`.
2. **Auth gate** — `chat.php` refuses to render until a session exists
   and redirects to `index.php` otherwise.
3. **Bootstrap injection** — the chosen Go server URL and bearer token
   are written into `window.OREO` for the JS to pick up on boot.

Everything else — WebSocket, REST history pulls, file uploads, avatar
display, reactions, presence, typing, reads — happens in the browser
talking **directly** to the Go server. PHP is never a proxy.

## Layout

```
web/
├── Dockerfile               # php:8.3-apache image
├── README.md                # this file
├── public/                  # Apache document root
│   ├── .htaccess
│   ├── index.php            # login form
│   ├── chat.php             # main app shell (auth-gated)
│   ├── logout.php
│   └── assets/
│       ├── css/style.css
│       └── js/
│           ├── api.js       # REST wrapper around the Go server
│           ├── ws.js        # WebSocket client + send helpers
│           ├── ui.js        # tiny DOM helpers + Avatar component
│           └── app.js       # main controller (state + event glue)
└── src/                     # PHP includes (not web-accessible)
    ├── config.php           # env-driven server URL resolution
    ├── session.php          # $_SESSION helpers + auth gate
    └── api.php              # server-to-server REST during login
```

## Running it

### Local dev (no Docker)

```bash
# 1) Start the Go server on :8080 as usual:
cd server && go run ./cmd/oreohouse serve

# 2) In another shell, serve the web client on :8000:
cd web/public
php -S localhost:8000
```

Browse to <http://localhost:8000/>. The PHP app calls
`http://localhost:8080/api/auth/login` server-to-server, then the
browser hits the same `:8080` for everything else (CORS is already wide
open on the Go side, and the WS handshake skips Origin checks).

### Docker (local build)

The repo's `docker-compose.yml` builds both images from source — good
for development, but slow because it compiles the Go server every
time. Use this when you're iterating on the code:

```bash
docker compose up --build
# → browse to http://<your-server>/
```

### Docker (pulling from GHCR)

For production / home-server deployment, pull the prebuilt images
from GitHub Container Registry. **They are two separate images** —
the server image has no PHP/Apache and pointing the web service at
it will just start a second Go server with nothing on port 80.

| Image | Tag | What it is |
|---|---|---|
| `ghcr.io/biffstagaming/oreohouse` | `latest` / `vX.Y.Z` | Go server (chat backend + WS + REST) |
| `ghcr.io/biffstagaming/oreohouse-web` | `latest` / `vX.Y.Z` | PHP + Apache web client |

Minimal production `compose.yaml`:

```yaml
services:
  oreohouse:
    image: ghcr.io/biffstagaming/oreohouse:latest
    container_name: oreohouse
    ports:
      - "8080:8080"
    volumes:
      - /apps/oreohouse/data:/data
    environment:
      OREOHOUSE_ADDR: ":8080"
      OREOHOUSE_DATA_DIR: "/data"
      OREOHOUSE_SESSION_TTL_DAYS: "0"
    restart: unless-stopped

  oreohouse-web:
    image: ghcr.io/biffstagaming/oreohouse-web:latest
    container_name: oreohouse-web
    ports:
      - "8079:80"        # change to "80:80" if you don't run anything else on :80
    environment:
      # PHP-side URL — service name resolves over the Docker network.
      OREO_SERVER_URL: "http://oreohouse:8080"
      # Browser-side URL — leave empty to auto-derive
      # (http://<request-host>:8080), or pin it to whatever your LAN
      # hostname is, e.g. "http://vm-internal.home:8080".
      OREO_BROWSER_SERVER_URL: ""
    depends_on:
      - oreohouse
    restart: unless-stopped
```

After `docker compose up -d`, browse to `http://<your-server>:8079/`.

## Configuration

Two environment variables, both read by the PHP container:

| Var | Default | Purpose |
|-----|---------|---------|
| `OREO_SERVER_URL` | `http://localhost:8080` | URL the **PHP process** uses for the login REST call. Inside Docker compose this is `http://oreohouse:8080` so it can resolve via Docker DNS. |
| `OREO_BROWSER_SERVER_URL` | (auto) | URL the **browser** uses for WebSocket + REST. When unset, the PHP code derives it from `$_SERVER['HTTP_HOST']` (stripping any port) and appends `:8080`. Override this if your browser cannot reach the same hostname the PHP container uses. |

In a typical home setup (e.g. R720xd running compose at
`192.168.1.10`), the defaults work: PHP talks to `oreohouse:8080`
inside the Docker network, browsers talk to `192.168.1.10:8080`
directly, and CORS lets that work.

## Feature parity vs the desktop client

What works:

- Login + logout (via PHP form, server session).
- Contact list with online/away/busy/offline presence dots.
- One-click DM start with any online user.
- Open any conversation; live messages over WS.
- Send messages, file uploads, image attachments (drag-drop, file
  picker, clipboard paste).
- Image lightbox.
- Emoji picker for both composer + reactions.
- Reaction pills + hover toolbar.
- Typing indicators.
- Nudge button (sends + animates the chat pane).
- Read receipts (cursor advances + receipts are tracked; tick marks
  not rendered yet).
- Profile editor (display name + avatar upload/remove).
- Title-bar unread badge.
- Auto-reconnect with replay-on-reconnect from the server's per-member
  delivery cursor.

What's intentionally **not** in the web client:

- **Multi-window pop-out chats** — browsers can't open native
  sub-windows reliably. The web client uses a single-pane layout where
  the sidebar selects the conversation.
- **Nudges shaking the recipient's whole window** — we animate the
  chat pane instead. Cross-browser window-shake is too fragile.
- **System tray / taskbar flash / native notifications** — not in MVP.
  The browser's `Notification` API is the path forward; left as a
  future stretch.
- **Geometry persistence** — no chat sub-windows, no geometry to
  persist.
- **In-app auto-update** — there's no app to update; the user refreshes
  the page.
- **Message edit / delete / reply / pin / search / per-conv mute /
  slash-commands** — these are part of the desktop client's
  `feature/avatars-emoji-reactions` branch (PR #16). The WS helpers
  in `ws.js` are wired up forward-compatibly (`sendEdit`,
  `sendDelete`, `sendPin`, etc.), but no UI surfaces them yet. They
  become usable once PR #16 merges and a follow-up adds buttons.

## Architecture notes

- **No build step.** Vanilla JS + plain CSS. View source, edit, refresh.
- **Single state object.** `state` in `app.js` holds the whole world.
  Re-render functions repaint the sidebar / message log / typing bar
  on demand.
- **WS reconnect with backoff** is in `ws.js`. The Go server replays
  missed messages on reconnect from each member's delivery cursor, so
  the client just re-renders the fresh batch.
- **Auth tokens** flow through `window.OREO.token`, which PHP populates
  from `$_SESSION`. The token rides on every REST call (Authorization
  header) and on the WS connect query (`?token=`). Image/file requests
  put it in the query string too, since `<img src>` can't carry
  headers.
- **Session storage** is PHP-side only (`$_SESSION` backed by the
  default file handler). The browser sees only the bearer token, never
  the password.

## Security posture

Same LAN-only stance as the rest of OreoHouse:

- No TLS by default. If you ever want to expose this outside the LAN,
  put it behind Tailscale or a real reverse proxy with HTTPS — don't
  open port 80/8080 to the internet.
- PHP `session.cookie_httponly = 1` and `SameSite=Lax`, so the auth
  cookie isn't reachable from JS and isn't sent on cross-origin
  navigations.
- The bearer token does leave PHP-side storage and lands in
  `window.OREO.token`, where it has the same lifetime as the rendered
  page. Treat this exactly like any SPA with token-in-memory: a small
  XSS surface is the risk, and the CSS/JS is small enough to audit by
  hand.

## Decision log

See [`docs/decisions/0005-php-web-client.md`](../docs/decisions/0005-php-web-client.md)
for the "why this lives in the same repo + why PHP at all" notes.

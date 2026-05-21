# 0005 — Browser-based chat client in PHP, same repo

**Status:** accepted

## Context

Some computers on the LAN can't (or won't) install the Tauri desktop
client — guest laptops, work-managed PCs, the kids' Chromebooks.
We want them to still be able to chat without lowering the bar for
everyone else.

The user asked for the client to be written in **PHP**.

Two structural questions had to be answered:

1. **Same repo or a new `OreoHouseWeb` repo?**
2. **How much of the chat client should actually live in PHP vs.
   JavaScript in the browser?**

## Decision

### 1. Same repo (`OreoHouse/web/`).

This is a hobby project with one developer. The wire protocol is
small and changes occasionally; keeping the web client beside the
server and desktop client means:

- A protocol change is one PR that updates the Go server, the
  TypeScript client, AND the PHP/JS client in one go.
- Docs, ADRs, CHANGELOG, and CLAUDE.md all stay singular.
- `docker compose up` brings up both server and web client in one
  shot — no second repo to clone.

The cost of a slightly more mixed-language repo (Go + TypeScript +
PHP + JS now) is small compared to the cost of keeping three repos
in lockstep by hand.

### 2. PHP is a thin shell; the SPA does the chatting.

PHP does exactly three things:

1. Render the **login form** and call `POST /api/auth/login` on submit.
2. Store the resulting bearer token + user snapshot in `$_SESSION`.
3. Render `chat.php`, which injects `window.OREO = { serverUrl, token,
   user }` and then loads vanilla-JS files that take over.

After that, the browser talks **directly** to the Go server for
everything — REST history, WebSocket, file uploads, avatars. PHP
isn't a proxy.

Why this split:

- PHP doesn't do persistent WebSockets gracefully without long-lived
  process frameworks (Ratchet, Workerman). Letting the browser
  connect WS straight to Go is the simple path.
- The Go server already has wide-open CORS (`AllowedOrigins: ["*"]`)
  and the WS handshake uses `InsecureSkipVerify: true` — so a
  browser at one origin can hit a server at another origin with
  zero extra server work.
- It keeps the PHP code tiny (~3 includes + 3 entry-point pages),
  which is appropriate for the hobby scale.

## Consequences

**Makes easier:**

- Adding a new wire-protocol message: edit one file in proto/, one in
  client/, one in web/. All in the same PR.
- Onboarding family members: "open <http://homeserver/> on your phone
  or guest laptop, no install needed".
- Operating: same Docker compose, same backup story (the SQLite file
  is the database for both clients).

**Makes harder:**

- Repo now mixes four languages (Go / TS / PHP / JS) plus their
  tooling assumptions. Contributors need to read three READMEs to
  cover everything.
- release-please's component-aware config now needs to know about a
  third component if we ever want versioned web releases. For now we
  ship the web client unversioned alongside the server.

## Considered alternatives

- **Separate `OreoHouseWeb` repo.** Rejected: protocol drift would
  bite. The benefit (cleaner per-repo language story) doesn't justify
  the maintenance cost at family scale.
- **Make the web client a React build of the existing desktop UI.**
  Rejected: the user explicitly asked for PHP, and the React app
  assumes Tauri-shaped APIs (system tray, multi-window) that don't
  translate to a browser without rewrites.
- **PHP proxies the WebSocket via something like Ratchet.** Rejected:
  introduces a long-lived PHP process, breaks the "PHP-FPM under
  Apache" simplicity of the chosen image, and adds nothing vs. letting
  the browser connect directly.

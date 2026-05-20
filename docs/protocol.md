# OreoHouse wire protocol v1

Transport: a single WebSocket connection per client window at `GET /ws?token=<session-token>`. The session token is obtained via `POST /api/auth/login` (see [README — Authentication](../README.md#authentication)). Connections without a valid token are rejected with HTTP 401 *before* the WebSocket upgrade — there is no in-band auth-failure message.

All messages are JSON objects with a top-level `"type"` field used as a discriminator. Field types are JSON-native (string, number, boolean, array, object, null).

## Versioning

This document is protocol **v1**. Adding new optional fields and new message types is non-breaking. Renaming or removing fields, changing semantics, or repurposing a `type` value is breaking and will bump the version.

The `UserInfo` shape is shared with the REST API:

```json
{ "id": 1, "username": "alice", "created_at": "2026-05-21T07:00:00Z" }
```

## Message catalog

### Server → client

#### `welcome`

Sent once immediately after a successful upgrade. Snapshots presence so the client can build its initial UI without polling.

```json
{
  "type": "welcome",
  "you": { "id": 1, "username": "alice", "created_at": "..." },
  "online": [
    { "id": 1, "username": "alice", "created_at": "..." },
    { "id": 2, "username": "bob",   "created_at": "..." }
  ]
}
```

`online` includes the receiver, so the client never needs a special case for "is that me?".

#### `presence`

Broadcast to every online client when a user comes online or goes offline.

```json
{
  "type": "presence",
  "user":   { "id": 1, "username": "alice", "created_at": "..." },
  "status": "online"
}
```

`status` is `"online"` or `"offline"`. A user "comes online" when their first connection opens, "goes offline" when the last one closes. A user with two concurrent connections still counts as one online user for presence purposes — `presence` is emitted only on edges.

#### `error`

Sent right before the server closes a connection due to a protocol violation mid-stream. Auth failures on `/ws?token=` are reported as HTTP 401 *before* the upgrade and don't produce an `error` message.

```json
{ "type": "error", "code": "invalid_message", "message": "expected object with \"type\" field" }
```

`code` is a stable identifier; `message` is human-readable detail.

#### `pong`

Reply to a client `ping`.

```json
{ "type": "pong" }
```

### Client → server

#### `ping`

Keepalive heartbeat. The server replies with `pong`. Clients should send one every ~30 s to detect dead links.

```json
{ "type": "ping" }
```

## Connection lifecycle

1. Client obtains a session token via `POST /api/auth/login`.
2. Client opens `ws://host:8080/ws?token=<token>`. The server validates the token via the same session lookup the REST API uses.
3. On success the server sends `welcome`, then broadcasts `presence` with `status="online"` for this user *iff this is the user's first connection*.
4. The connection stays open until either side closes it.
5. When the last connection for a user closes, the server broadcasts `presence` with `status="offline"` and updates the user's `last_seen_at` column in SQLite.

## Reserved / future types

These appear in the protocol enum for forward-compatibility but the server currently ignores them or replies with `error`/`code="unknown_type"`:

- `status` (client → server) — explicit presence override (away, busy, custom message). Phase 7.
- `message` (both directions) — chat messages. Phase 3.
- `typing` (both directions) — typing indicator. Phase 7.
- `nudge` (both directions) — window-shake nudge. Phase 7.

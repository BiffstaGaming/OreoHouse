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

#### `message`

Broadcast to every member of a conversation (including the sender) whenever someone posts. Also used to replay missed messages on reconnect — the shape is identical, the client doesn't need to distinguish "live" from "replay".

```json
{
  "type": "message",
  "id": 42,
  "conversation_id": 7,
  "sender": { "id": 1, "username": "alice", "created_at": "..." },
  "body": "hello",
  "created_at": "..."
}
```

`id` is a monotonically increasing 64-bit integer assigned by the server. Clients can use it both as a stable identifier (for dedup) and as a cursor for paginating history via `GET /api/conversations/{id}/messages?before=<id>`.

#### `conversation_added`

Pushed to a user the moment they're added to a new conversation (created in a group / invited to a group / joined a room). Carries the full conversation view so the client can drop it into its list without an extra REST round-trip.

```json
{
  "type": "conversation_added",
  "conversation": {
    "id": 12,
    "type": "group",
    "name": "Family",
    "created_at": "...",
    "members": [
      { "id": 1, "username": "alice", "created_at": "..." },
      { "id": 2, "username": "bob",   "created_at": "..." }
    ]
  }
}
```

#### `conversation_members_changed`

Pushed to the *existing* members of a conversation whenever its membership changes (someone added, someone left). Carries the new full member list — clients should replace, not diff.

```json
{
  "type": "conversation_members_changed",
  "conversation_id": 12,
  "members": [
    { "id": 1, "username": "alice", "created_at": "..." },
    { "id": 2, "username": "bob",   "created_at": "..." },
    { "id": 3, "username": "carol", "created_at": "..." }
  ]
}
```

A user who is themselves the change-target — the joiner / new invitee — gets `conversation_added` instead and does not receive a parallel `conversation_members_changed` for the same event.

#### `error`

Sent right before the server closes a connection due to a protocol violation mid-stream. Auth failures on `/ws?token=` are reported as HTTP 401 *before* the upgrade and don't produce an `error` message. The connection is NOT closed for application-level errors raised by client `message` events (e.g. body too long, not a member) — those just emit an `error` and let the client retry.

```json
{ "type": "error", "code": "forbidden", "message": "not a member of conversation" }
```

Stable `code` values:

| `code`             | Meaning                                                  |
|--------------------|----------------------------------------------------------|
| `invalid_message`  | Malformed JSON / unknown shape / failed validation       |
| `forbidden`        | Authenticated but not allowed (e.g. not a member)        |
| `unknown_type`     | Reserved — never currently emitted; see "Reserved" below |

### Client → server

#### `ping`

Keepalive heartbeat. The server replies with `pong`. Clients should send one every ~30 s to detect dead links.

```json
{ "type": "ping" }
```

#### `message`

Post a message to a conversation the sender is a member of. Body is 1..4096 bytes, plain text only.

```json
{ "type": "message", "conversation_id": 7, "body": "hello" }
```

The server validates membership and body length; on failure it sends an `error` event (with `code` `invalid_message` or `forbidden`) and keeps the connection open. On success it broadcasts an `message` event (server→client shape above) to every member, including the sender — so the sender's UI adds the row through the same path everyone else does.

## Connection lifecycle

1. Client obtains a session token via `POST /api/auth/login`.
2. Client opens `ws://host:8080/ws?token=<token>`. The server validates the token via the same session lookup the REST API uses.
3. On success the server sends `welcome`, then broadcasts `presence` with `status="online"` for this user *iff this is the user's first connection*.
4. Server replays any `message` events the user missed while offline — for each conversation they're in, it sends every message with `id > last_delivered_message_id` and advances that cursor. Replay completes before live messages start streaming.
5. The connection stays open until either side closes it. Outgoing messages from this client are sent as `message` envelopes; the server persists, broadcasts to all conversation members, and advances each online recipient's delivery cursor.
6. When the last connection for a user closes, the server broadcasts `presence` with `status="offline"` and updates the user's `last_seen_at` column in SQLite.

## Reserved / future types

These appear in the protocol enum for forward-compatibility but the server currently ignores them silently:

- `status` (client → server) — explicit presence override (away, busy, custom message). Phase 7.
- `typing` (both directions) — typing indicator. Phase 7.
- `nudge` (both directions) — window-shake nudge. Phase 7.

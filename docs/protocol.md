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
    {
      "user":  { "id": 1, "username": "alice", "created_at": "..." },
      "state": "online"
    },
    {
      "user":        { "id": 2, "username": "bob", "created_at": "..." },
      "state":       "away",
      "custom_text": "afk getting tea"
    }
  ],
  "reads": [
    {
      "conversation_id": 7,
      "user_id": 2,
      "last_read_message_id": 41,
      "at": "..."
    }
  ]
}
```

`online` includes the receiver, so the client never needs a special case for "is that me?". `state` is `"online" | "away" | "busy"` (`"offline"` never appears in the snapshot — offline users aren't in it). `custom_text` is omitted when the user hasn't set one.

`reads` is the snapshot of every `(conversation_id, user_id, last_read_message_id)` row visible to the receiver — exactly the conversations they're a member of. Empty array on a brand-new install with no read activity yet.

#### `presence`

Broadcast to every online client when a user's presence changes — they came online, went offline, or changed their `state` / `custom_text`.

```json
{
  "type": "presence",
  "user":        { "id": 1, "username": "alice", "created_at": "..." },
  "state":       "away",
  "custom_text": "afk getting tea"
}
```

`state` is `"online" | "away" | "busy" | "offline"`. On an offline edge the client should drop the user from its online map; otherwise replace the entry with the new state + text. `custom_text` is omitted when the user hasn't set one.

A user "comes online" when their first connection opens, "goes offline" when the last one closes; concurrent connections still count as one online user, and only edges are broadcast. State changes within an existing session are broadcast each time.

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
  "created_at": "...",
  "attachments": [
    {
      "id": 9,
      "filename": "cat.jpg",
      "mime_type": "image/jpeg",
      "size_bytes": 234567,
      "image_width": 1024,
      "image_height": 768
    }
  ]
}
```

`id` is a monotonically increasing 64-bit integer assigned by the server. Clients can use it both as a stable identifier (for dedup) and as a cursor for paginating history via `GET /api/conversations/{id}/messages?before=<id>`.

`attachments` is omitted when the message has none. Each attachment is fetched from `GET /api/files/{id}?token=<session>` — the query-param auth lets `<img src>` tags render images without setting a header. `image_width` / `image_height` are present (when known) so the client can reserve layout space.

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

#### `user_profile_changed`

Broadcast to every connected client whenever any user updates their
`display_name` or uploads/clears their avatar (via `PUT /api/me/profile`
or `POST /api/me/avatar`). Recipients should swap their cached
`UserInfo` for this user — contact list rows, message bubbles, and
chat-window headers all read from the same cache.

```json
{
  "type": "user_profile_changed",
  "user": {
    "id": 2,
    "username": "bob",
    "created_at": "...",
    "display_name": "Bob (Dad)",
    "has_avatar": true
  }
}
```

#### `reaction`

Broadcast to every member of a conversation when one of them toggles
an emoji reaction on a message. `action` is `"add"` or `"remove"`.
The sender's own UI updates from this same broadcast (one render
path).

```json
{
  "type": "reaction",
  "message_id": 42,
  "conversation_id": 7,
  "user": { "id": 1, "username": "alice", "created_at": "..." },
  "emoji": "👍",
  "action": "add"
}
```

#### `read_receipt`

Broadcast to the *other* members of a conversation when a user's read
cursor advances. The recipient should update its per-`(conversation_id,
user.id)` read map and re-render tick marks on the sender's own
messages.

```json
{
  "type": "read_receipt",
  "conversation_id": 7,
  "user": { "id": 2, "username": "bob", "created_at": "..." },
  "last_read_message_id": 42,
  "at": "..."
}
```

The cursor is monotonic — clients ignore receipts whose
`last_read_message_id` is less than the stored value for that user.
The user's *own* read cursor moves are not echoed back to them (they
emitted the client→server `read` to begin with).

#### `typing`

Fanned out to the *other* members of a conversation when one of them sends a client→server `typing`. There is no acknowledgement to the sender, and no event is emitted to the typist themselves.

```json
{
  "type": "typing",
  "conversation_id": 7,
  "user": { "id": 1, "username": "alice", "created_at": "..." }
}
```

Receivers should show an indicator (e.g. "alice is typing…") and clear it ~5 s after the last `typing` for that `(conversation_id, user)` pair.

#### `nudge`

Fanned out to the *other* members of a conversation when one of them sends a client→server `nudge`. The recipient client should shake the chat window, play the nudge sound, and restore the window from minimized.

```json
{
  "type": "nudge",
  "conversation_id": 7,
  "sender": { "id": 1, "username": "alice", "created_at": "..." }
}
```

The server does not gate spam — clients self-impose a ~3 s cooldown on the send button.

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

Post a message to a conversation the sender is a member of. Either `body` (0..4096 bytes, plain text) or a non-empty `attachment_ids` array (or both) must be present.

```json
{
  "type": "message",
  "conversation_id": 7,
  "body": "look at this cat",
  "attachment_ids": [9]
}
```

`attachment_ids` references rows previously created by `POST /api/uploads`. Each ID must exist, be owned by the sender, and not already be linked to another message — otherwise the server emits an `error` event (`invalid_message` or `forbidden`) and the message is *not* persisted. On success it broadcasts the `message` event (server→client shape above, with the same attachment shapes inlined under `attachments`) to every conversation member, including the sender.

#### `status`

Set this user's discrete presence state and / or custom status text. The server validates `state ∈ {"online", "away", "busy"}` (`"offline"` is reserved for the disconnect edge) and persists `custom_text` to `users.status_text` so it sticks across sessions. On success the server broadcasts a server→client `presence` event with the new state + text to every online client.

```json
{
  "type":        "status",
  "state":       "away",
  "custom_text": "afk getting tea"
}
```

`custom_text` is always required — pass an empty string to clear it. There is no per-conversation state: `status` applies to the whole user.

#### `typing`

Tell the server "I'm typing in this conversation right now". The server fans out a server→client `typing` (above) to the other members. Senders should throttle to roughly one event per 2 s while actively typing.

```json
{ "type": "typing", "conversation_id": 7 }
```

The server validates membership but does not persist anything.

#### `nudge`

Send a window-shake nudge to the other members of a conversation. The server fans out a server→client `nudge` (above). Senders should self-impose a ~3 s cooldown on the send button to avoid spam.

```json
{ "type": "nudge", "conversation_id": 7 }
```

#### `react`

Toggle a reaction on a message. If `(message_id, sender, emoji)`
already has a row, it's removed; otherwise it's added. On success
the server broadcasts a server→client `reaction` (above) to every
member of the message's conversation, including the sender, so all
UIs render the same way.

```json
{ "type": "react", "message_id": 42, "emoji": "👍" }
```

The server validates that the message exists AND the sender is a
member of its conversation. There's no rate limit; clients pace via
the hover toolbar's UX.

#### `read`

Tell the server "I've read messages up to `last_read_message_id` in
this conversation". The server validates membership, persists
monotonically (no-op if the new id is ≤ the stored value), and fans
out a server→client `read_receipt` (above) to the *other* members
when the cursor actually advances.

```json
{ "type": "read", "conversation_id": 7, "last_read_message_id": 42 }
```

Clients should emit this when their chat window for the conversation
gains OS focus, using the highest message id they currently have
loaded for that conv. There is no server-side rate limit; the chat
UI's natural focus debouncing is sufficient.

## Connection lifecycle

1. Client obtains a session token via `POST /api/auth/login`.
2. Client opens `ws://host:8080/ws?token=<token>`. The server validates the token via the same session lookup the REST API uses.
3. On success the server sends `welcome`, then broadcasts `presence` with `state="online"` (carrying the user's persisted `custom_text` if any) for this user *iff this is the user's first connection*. Subsequent client→server `status` events broadcast further `presence` events for state / custom-text changes during the session.
4. Server replays any `message` events the user missed while offline — for each conversation they're in, it sends every message with `id > last_delivered_message_id` and advances that cursor. Replay completes before live messages start streaming.
5. The connection stays open until either side closes it. Outgoing messages from this client are sent as `message` envelopes; the server persists, broadcasts to all conversation members, and advances each online recipient's delivery cursor.
6. When the last connection for a user closes, the server broadcasts `presence` with `state="offline"` and updates the user's `last_seen_at` column in SQLite. The user's `status_text` is *not* cleared — it's restored on the next connect.

## Reserved / future types

None at the moment. All `type` values defined here are live as of Phase 7.

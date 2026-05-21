// JSON shapes that mirror server/internal/proto/. Kept in lockstep by
// hand — the surface is small enough to not need codegen yet.

// --- REST: /api/auth/login + /api/auth/logout -------------------------

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expires_at?: string;
  user: UserInfo;
}

export interface UserInfo {
  id: number;
  username: string;
  created_at: string;
  // Optional display name; clients fall back to `username` when empty.
  display_name?: string;
  // True when the user has an avatar uploaded. Fetch via
  // `${serverUrl}/api/users/${id}/avatar?token=...&v=<avatar_version>`.
  has_avatar?: boolean;
  // Bumps every time the user re-uploads their avatar. The client
  // appends it as `?v=` to bust the browser image cache without
  // changing the canonical URL path.
  avatar_version?: number;
}

export interface ErrorResponse {
  error: string;
}

// --- WS: /ws?token= ---------------------------------------------------
//
// See docs/protocol.md for semantics. Each message has a `"type"`
// discriminator at the top level.

export const MessageType = {
  Welcome: "welcome",
  Presence: "presence",
  Error: "error",
  Ping: "ping",
  Pong: "pong",
  Message: "message",
  ConversationAdded: "conversation_added",
  ConversationMembersChanged: "conversation_members_changed",
  Status: "status",
  Read: "read",
  ReadReceipt: "read_receipt",
  UserProfileChanged: "user_profile_changed",
  React: "react",
  Reaction: "reaction",
  Edit: "edit",
  MessageEdited: "message_edited",
  Delete: "delete",
  MessageDeleted: "message_deleted",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// User state values that appear in PresenceInfo.state and
// PresenceMessage.state. "offline" only appears in presence deltas —
// never in the welcome snapshot.
export const UserState = {
  Online: "online",
  Away: "away",
  Busy: "busy",
  Offline: "offline",
} as const;
export type UserState = (typeof UserState)[keyof typeof UserState];

// PresenceInfo is one row in the welcome.online snapshot: who's
// connected plus their state + optional custom text.
export interface PresenceInfo {
  user: UserInfo;
  state: UserState;
  custom_text?: string;
}

// ReadStateView is a row of conversation_read_states surfaced over
// the wire — in WelcomeMessage.reads (snapshot on connect) and
// individually in ReadReceiptMessage as the cursor advances live.
export interface ReadStateView {
  conversation_id: number;
  user_id: number;
  last_read_message_id: number;
  at: string;
}

export interface WelcomeMessage {
  type: "welcome";
  you: UserInfo;
  online: PresenceInfo[];
  reads: ReadStateView[];
}

// Broadcast to every connected client whenever a user's presence
// changes (online edge, status change, offline edge). Drop the user
// from the online map when state === "offline".
export interface PresenceMessage {
  type: "presence";
  user: UserInfo;
  state: UserState;
  custom_text?: string;
}

// Client→server: set my discrete state + custom message. The server
// validates state ∈ {online, away, busy} ("offline" is reserved) and
// broadcasts a PresenceMessage to all online clients.
export interface StatusMessage {
  type: "status";
  state: UserState;
  custom_text: string;
}

// Client→server: I'm typing in this conversation. Throttle to ~one
// event every 2 seconds while actively typing.
export interface IncomingTypingMessage {
  type: "typing";
  conversation_id: number;
}

// Server→other-members of a conversation: this user is typing.
// Clients should expire the indicator after ~5s with no further
// events.
export interface TypingMessage {
  type: "typing";
  conversation_id: number;
  user: UserInfo;
}

// Client→server: nudge everyone else in this conversation. Clients
// should self-impose a ~3s cooldown on the send button.
export interface IncomingNudgeMessage {
  type: "nudge";
  conversation_id: number;
}

// Server→other-members: shake the chat window and play the nudge
// sound. Restore the window from minimized state if needed.
export interface NudgeMessage {
  type: "nudge";
  conversation_id: number;
  sender: UserInfo;
}

export interface WSErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

// Server→client message broadcast. Same shape is used for both live
// messages and replay on reconnect; clients can dedupe by `id`.
export interface OutgoingMessage {
  type: "message";
  id: number;
  conversation_id: number;
  sender: UserInfo;
  body: string;
  created_at: string;
  edited_at?: string;
  deleted_at?: string;
  attachments?: AttachmentView[];
  reactions?: ReactionGroup[];
  reply_to?: ReplySnippet;
}

// Client→server: post a message to a conversation. Body is 0..4096
// bytes plain text; either body or attachment_ids (or both) must be
// non-empty. reply_to_id, when set, references a message in the same
// conversation that the new message quotes.
export interface IncomingMessage {
  type: "message";
  conversation_id: number;
  body: string;
  attachment_ids?: number[];
  reply_to_id?: number;
}

// Client→server: replace the body of one of YOUR own messages (within
// 15 minutes of sending). Server validates ownership + window.
export interface IncomingEditMessage {
  type: "edit";
  message_id: number;
  body: string;
}

// Server→all-members for a successful edit. Updates body + adds
// edited_at marker.
export interface MessageEditedMessage {
  type: "message_edited";
  message_id: number;
  conversation_id: number;
  body: string;
  edited_at: string;
}

// Client→server: soft-delete one of YOUR own messages. No time limit
// other than the membership check.
export interface IncomingDeleteMessage {
  type: "delete";
  message_id: number;
}

// Server→all-members: a message was deleted. Clients render the
// "this message was deleted" placeholder.
export interface MessageDeletedMessage {
  type: "message_deleted";
  message_id: number;
  conversation_id: number;
  deleted_at: string;
}

// Embedded quote preview on a reply message. Body is server-truncated
// to ~160 bytes; deleted=true means the original was soft-deleted.
export interface ReplySnippet {
  id: number;
  sender: UserInfo;
  body: string;
  deleted?: boolean;
}

// Pushed to a user when they're added to a new conversation.
export interface ConversationAddedMessage {
  type: "conversation_added";
  conversation: ConversationView;
}

// Pushed to existing members when a conversation's membership changes.
// Carries the new full member list — replace, don't diff.
export interface ConversationMembersChangedMessage {
  type: "conversation_members_changed";
  conversation_id: number;
  members: UserInfo[];
}

// Client→server: I've read messages up to last_read_message_id in
// this conversation. The server validates membership, persists
// monotonically, and broadcasts a ReadReceiptMessage to other members
// iff the cursor actually advances.
export interface IncomingReadMessage {
  type: "read";
  conversation_id: number;
  last_read_message_id: number;
}

// Server→other-members: a user's read cursor in a conversation has
// advanced. Receivers should update their per-(conv, user) map and
// re-render tick marks on the sender's own messages.
export interface ReadReceiptMessage {
  type: "read_receipt";
  conversation_id: number;
  user: UserInfo;
  last_read_message_id: number;
  at: string;
}

// Server→all clients: a user updated their display_name or avatar.
// Clients should swap their cached UserInfo for this user in one
// operation (contact list rows, open chat windows).
export interface UserProfileChangedMessage {
  type: "user_profile_changed";
  user: UserInfo;
}

// Client→server: toggle a reaction on a message. The server adds the
// reaction if absent, removes it if present, and broadcasts a
// ReactionMessage to every conversation member.
export interface IncomingReactMessage {
  type: "react";
  message_id: number;
  emoji: string;
}

// Server→all-members of the message's conversation: a reaction was
// toggled. `action` is "add" or "remove".
export interface ReactionMessage {
  type: "reaction";
  message_id: number;
  conversation_id: number;
  user: UserInfo;
  emoji: string;
  action: "add" | "remove";
}

// Per-message reaction summary surfaced in MessageView.reactions.
export interface ReactionGroup {
  emoji: string;
  user_ids: number[];
}

export type ServerMessage =
  | WelcomeMessage
  | PresenceMessage
  | WSErrorMessage
  | PongMessage
  | OutgoingMessage
  | ConversationAddedMessage
  | ConversationMembersChangedMessage
  | TypingMessage
  | NudgeMessage
  | ReadReceiptMessage
  | UserProfileChangedMessage
  | ReactionMessage
  | MessageEditedMessage
  | MessageDeletedMessage;

export type ClientMessage =
  | PingMessage
  | IncomingMessage
  | StatusMessage
  | IncomingTypingMessage
  | IncomingNudgeMessage
  | IncomingReadMessage
  | IncomingReactMessage
  | IncomingEditMessage
  | IncomingDeleteMessage;

// --- REST: /api/conversations* -------------------------------------

export interface ConversationView {
  id: number;
  type: "dm" | "group" | "room";
  name?: string;
  topic?: string;
  created_at: string;
  members: UserInfo[];
}

export interface ListConversationsResponse {
  conversations: ConversationView[];
}

export interface CreateDMRequest {
  user_id: number;
}

export interface CreateGroupRequest {
  name?: string;
  member_ids: number[];
}

export interface CreateRoomRequest {
  name: string;
  topic?: string;
}

export interface AddMembersRequest {
  user_ids: number[];
}

export interface RoomView {
  id: number;
  name: string;
  topic?: string;
  created_at: string;
  member_count: number;
}

export interface ListRoomsResponse {
  rooms: RoomView[];
}

export interface MessageView {
  id: number;
  conversation_id: number;
  sender: UserInfo;
  body: string;
  created_at: string;
  edited_at?: string;
  deleted_at?: string;
  attachments?: AttachmentView[];
  reactions?: ReactionGroup[];
  reply_to?: ReplySnippet;
}

export interface ListMessagesResponse {
  messages: MessageView[];
}

// JSON shape returned by POST /api/uploads and nested under
// OutgoingMessage / MessageView. Fetched bytes live at
// `${serverUrl}/api/files/${id}?token=<session>` — the query-param
// auth is required because <img src> can't carry an Authorization
// header.
export interface AttachmentView {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  image_width?: number;
  image_height?: number;
}

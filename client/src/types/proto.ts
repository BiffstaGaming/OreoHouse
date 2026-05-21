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
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const PresenceStatus = {
  Online: "online",
  Offline: "offline",
} as const;
export type PresenceStatus =
  (typeof PresenceStatus)[keyof typeof PresenceStatus];

export interface WelcomeMessage {
  type: "welcome";
  you: UserInfo;
  online: UserInfo[];
}

export interface PresenceMessage {
  type: "presence";
  user: UserInfo;
  status: PresenceStatus;
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
}

// Client→server: post a message to a conversation. Body is 1..4096
// bytes, plain text.
export interface IncomingMessage {
  type: "message";
  conversation_id: number;
  body: string;
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

export type ServerMessage =
  | WelcomeMessage
  | PresenceMessage
  | WSErrorMessage
  | PongMessage
  | OutgoingMessage
  | ConversationAddedMessage
  | ConversationMembersChangedMessage;

export type ClientMessage = PingMessage | IncomingMessage;

// --- REST: /api/conversations* -------------------------------------

export interface ConversationView {
  id: number;
  type: "dm" | "group" | "room";
  name?: string;
  created_at: string;
  members: UserInfo[];
}

export interface ListConversationsResponse {
  conversations: ConversationView[];
}

export interface CreateDMRequest {
  user_id: number;
}

export interface MessageView {
  id: number;
  conversation_id: number;
  sender: UserInfo;
  body: string;
  created_at: string;
}

export interface ListMessagesResponse {
  messages: MessageView[];
}

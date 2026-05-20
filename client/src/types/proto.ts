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

export type ServerMessage =
  | WelcomeMessage
  | PresenceMessage
  | WSErrorMessage
  | PongMessage;

export type ClientMessage = PingMessage;

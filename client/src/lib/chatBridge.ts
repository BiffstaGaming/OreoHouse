// chatBridge.ts — typed IPC contract between the main window and the
// per-conversation chat sub-windows.
//
// Each chat window is its own Tauri window with label
// `chat-{conversation_id}` and URL `#/chat/{id}`. The MAIN window owns
// the WebSocket and conversation state; chat windows are pure UI that
// hydrate via these events.
//
// Naming convention: all event names start with "oreo:chat:" so they
// stay obviously OreoHouse-flavored amid Tauri's own `tauri://*`
// events.

import type {
  AttachmentView,
  ConversationView,
  MessageView,
  UserInfo,
} from "../types/proto";

// ---- shared shapes --------------------------------------------------

export type SessionSnapshot = {
  serverUrl: string;
  token: string;
  user: UserInfo;
};

// HydratePayload is the full state a freshly-spawned chat window needs
// to render. Main sends it in response to a ChatReady ping.
export type HydratePayload = {
  session: SessionSnapshot;
  conv: ConversationView;
  messages: MessageView[];
  // Initial typers (rarely populated unless someone was already typing
  // when we opened the window).
  typers: { username: string; expiresAt: number }[];
  // Initial muted-sound preference (so we don't have to share
  // localStorage races with the main window).
  muted: boolean;
};

export type MessagePayload = {
  message: MessageView;
};

export type TypingPayload = {
  user: UserInfo;
  expiresAt: number;
};

export type NudgePayload = {
  sender: UserInfo;
};

export type MembersChangedPayload = {
  members: UserInfo[];
};

export type ConvUpdatedPayload = {
  conv: ConversationView;
};

export type SendPayload = {
  body: string;
  attachment_ids?: number[];
};

// ---- event names ----------------------------------------------------
//
// `main_to_chat` events are emitted by the main window and listened to
// by the corresponding chat window. We use `emitTo(label, ...)` to keep
// the cross-window fanout single-target. Conversely, chat windows emit
// `chat_to_main` events as plain `emit(...)` and the main window picks
// them up via `listen(...)` with the conversation_id encoded in the
// payload.

export const EVT = {
  // main → chat (sent via emitTo("chat-{id}", ...))
  Hydrate: "oreo:chat:hydrate",
  IncomingMessage: "oreo:chat:message",
  IncomingTyping: "oreo:chat:typing",
  IncomingNudge: "oreo:chat:nudge",
  MembersChanged: "oreo:chat:members_changed",
  ConvUpdated: "oreo:chat:conv_updated",
  MutedChanged: "oreo:chat:muted_changed",
  // chat → main (plain emit, conv id is in the payload)
  Ready: "oreo:chat:ready",
  Send: "oreo:chat:send",
  OutgoingTyping: "oreo:chat:typing_out",
  OutgoingNudge: "oreo:chat:nudge_out",
  Focused: "oreo:chat:focused",
  Leave: "oreo:chat:leave",
} as const;

// Chat → main payloads always carry the conversation id so the main
// window doesn't need to maintain a window-label → conv-id map.
export type ChatToMainEnvelope<T> = T & { conversation_id: number };

// Helpers a chat window uses to emit envelopes.
export function ready(conversation_id: number): ChatToMainEnvelope<{}> {
  return { conversation_id };
}

export function send(
  conversation_id: number,
  body: string,
  attachment_ids?: number[],
): ChatToMainEnvelope<SendPayload> {
  return { conversation_id, body, attachment_ids };
}

// Re-exports so chat windows don't have to reach back through proto.
export type { AttachmentView, ConversationView, MessageView, UserInfo };

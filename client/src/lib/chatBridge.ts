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
  ReactionGroup,
  ReplySnippet,
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
  // True when THIS conversation has been individually muted by the
  // user. Server-side messages still arrive, but the chat window
  // suppresses its blip + flash and main suppresses the badge bump.
  conv_muted: boolean;
  // Initial read-state map for this conversation: user_id →
  // last_read_message_id. Hydrated from welcome.reads + any live
  // read_receipt events that arrived before the window opened.
  reads: Record<number, number>;
  // Initial per-message reaction summary for the conversation's
  // loaded history. Keyed by message_id.
  reactions: Record<number, ReactionGroup[]>;
  // Initial set of pinned message ids in this conversation.
  pinned: number[];
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

// One incoming read_receipt update for the chat window. The chat
// window stores its own per-conv reads map (keyed by user_id) so it
// can render tick marks without going back to main.
export type ReadReceiptPayload = {
  user_id: number;
  last_read_message_id: number;
};

// One incoming reaction toggle. Chat windows store reactions keyed
// by message_id and apply the (user_id, emoji, action) delta.
export type ReactionPayload = {
  message_id: number;
  user_id: number;
  emoji: string;
  action: "add" | "remove";
};

// One UserInfo update — fanned out to every open chat window when
// any user's display_name or avatar changes so the conv member list,
// message bubbles, etc. swap to the new view in one operation.
export type UserUpdatedPayload = {
  user: UserInfo;
};

export type SendPayload = {
  body: string;
  attachment_ids?: number[];
  reply_to_id?: number;
};

export type OutgoingReactPayload = {
  message_id: number;
  emoji: string;
};

export type OutgoingEditPayload = {
  message_id: number;
  body: string;
};

export type OutgoingDeletePayload = {
  message_id: number;
};

export type MessageEditedPayload = {
  message_id: number;
  body: string;
  edited_at: string;
};

export type MessageDeletedPayload = {
  message_id: number;
  deleted_at: string;
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
  IncomingReadReceipt: "oreo:chat:read_receipt",
  IncomingReaction: "oreo:chat:reaction",
  IncomingMessageEdited: "oreo:chat:message_edited",
  IncomingMessageDeleted: "oreo:chat:message_deleted",
  IncomingMessagePinned: "oreo:chat:message_pinned",
  IncomingMessageUnpinned: "oreo:chat:message_unpinned",
  UserUpdated: "oreo:chat:user_updated",
  MembersChanged: "oreo:chat:members_changed",
  ConvUpdated: "oreo:chat:conv_updated",
  MutedChanged: "oreo:chat:muted_changed",
  ConvMuteChanged: "oreo:chat:conv_mute_changed",
  // chat → main (plain emit, conv id is in the payload)
  Ready: "oreo:chat:ready",
  Send: "oreo:chat:send",
  OutgoingTyping: "oreo:chat:typing_out",
  OutgoingNudge: "oreo:chat:nudge_out",
  OutgoingReact: "oreo:chat:react_out",
  OutgoingEdit: "oreo:chat:edit_out",
  OutgoingDelete: "oreo:chat:delete_out",
  OutgoingPin: "oreo:chat:pin_out",
  OutgoingUnpin: "oreo:chat:unpin_out",
  ToggleConvMute: "oreo:chat:toggle_conv_mute",
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
export type {
  AttachmentView,
  ConversationView,
  MessageView,
  ReactionGroup,
  ReplySnippet,
  UserInfo,
};

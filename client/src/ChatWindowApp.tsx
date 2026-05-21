// ChatWindowApp — the React root rendered inside each chat sub-window.
//
// A chat window is a real OS window spawned by the main window; the
// URL hash carries the conversation id (`#/chat/{id}`). The main
// window owns the WebSocket — this component is pure UI that hydrates
// from a Tauri event and pushes user actions back as more events. See
// lib/chatBridge.ts for the contract.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { fileURL, uploadFile } from "./lib/api";
import { playMessageBlip, playNudge } from "./lib/sounds";
import { flashWindowIfUnfocused, setWindowTitle } from "./lib/tauri";
import {
  EVT,
  type AttachmentView,
  type ConversationView,
  type HydratePayload,
  type MessagePayload,
  type MessageDeletedPayload,
  type MessageEditedPayload,
  type MembersChangedPayload,
  type ConvUpdatedPayload,
  type MessageView,
  type NudgePayload,
  type ReactionGroup,
  type ReactionPayload,
  type ReadReceiptPayload,
  type ReplySnippet,
  type SessionSnapshot,
  type TypingPayload,
  type UserInfo,
  type UserUpdatedPayload,
} from "./lib/chatBridge";
import { Avatar } from "./components/Avatar";
import { EmojiPicker } from "./components/EmojiPicker";
import { QUICK_REACTIONS } from "./lib/emoji";
import { expandSlashCommand } from "./lib/slashCommands";
import { displayNameOf } from "./lib/users";

import "./App.css";

const TYPING_SEND_THROTTLE_MS = 2000;
const NUDGE_COOLDOWN_MS = 3000;
const SHAKE_DURATION_MS = 700;

type PendingAttachment =
  | { kind: "uploading"; localID: string; filename: string }
  | { kind: "ready"; localID: string; view: AttachmentView }
  | { kind: "error"; localID: string; filename: string; error: string };

export default function ChatWindowApp({ convID }: { convID: number }) {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [conv, setConv] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [typers, setTypers] = useState<
    Map<number, { username: string; expiresAt: number }>
  >(new Map());
  const [shaking, setShaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [convMuted, setConvMuted] = useState(false);
  // user_id → highest message_id they've read in this conversation.
  const [reads, setReads] = useState<Map<number, number>>(new Map());
  // message_id → reaction groups for that message.
  const [reactions, setReactions] = useState<Map<number, ReactionGroup[]>>(
    new Map(),
  );
  // user_id → latest UserInfo (display_name, has_avatar). Hydrated from
  // conv.members + each message.sender, and updated by UserUpdated.
  const [userCache, setUserCache] = useState<Map<number, UserInfo>>(new Map());

  // Use refs so the listen()-callbacks (set up once) can see the latest
  // session/muted without re-subscribing.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const convMutedRef = useRef(convMuted);
  convMutedRef.current = convMuted;

  // ---- IPC: subscribe + announce ready ------------------------------

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    async function setup() {
      // Filter every listener by THIS webview's label so a main→chat
      // emitTo("chat-2", ...) doesn't also fire here in chat-1.
      // The default listen target is `{ kind: 'Any' }` which receives
      // events for any target — exactly the leak we don't want.
      const myLabel = getCurrentWindow().label;
      const opts = {
        target: { kind: "WebviewWindow" as const, label: myLabel },
      };

      unlisteners.push(
        await listen<HydratePayload>(
          EVT.Hydrate,
          (e) => {
            if (e.payload.conv.id !== convID) return;
            setSession(e.payload.session);
            setConv(e.payload.conv);
            setMessages([...e.payload.messages].sort((a, b) => a.id - b.id));
            setTypers(
              new Map(e.payload.typers.map((t, i) => [-1 - i, t])),
            );
            setMuted(e.payload.muted);
            setConvMuted(e.payload.conv_muted);
            const reads = new Map<number, number>();
            for (const [uid, lr] of Object.entries(e.payload.reads ?? {})) {
              reads.set(Number(uid), lr);
            }
            setReads(reads);
            const rxs = new Map<number, ReactionGroup[]>();
            for (const [mid, groups] of Object.entries(
              e.payload.reactions ?? {},
            )) {
              rxs.set(Number(mid), groups);
            }
            setReactions(rxs);
            // Seed userCache from conv members + each message's sender.
            const uc = new Map<number, UserInfo>();
            uc.set(e.payload.session.user.id, e.payload.session.user);
            for (const m of e.payload.conv.members) uc.set(m.id, m);
            for (const msg of e.payload.messages) uc.set(msg.sender.id, msg.sender);
            setUserCache(uc);
          },
          opts,
        ),
        await listen<MessagePayload>(
          EVT.IncomingMessage,
          (e) => {
            const m = e.payload.message;
            if (m.conversation_id !== convID) return;
            setMessages((prev) => {
              if (prev.some((x) => x.id === m.id)) return prev;
              return [...prev, m].sort((a, b) => a.id - b.id);
            });
            setUserCache((prev) => {
              const next = new Map(prev);
              next.set(m.sender.id, m.sender);
              return next;
            });
            const me = sessionRef.current;
            if (
              me &&
              m.sender.id !== me.user.id &&
              !mutedRef.current &&
              !convMutedRef.current
            ) {
              playMessageBlip();
            }
          },
          opts,
        ),
        await listen<TypingPayload>(
          EVT.IncomingTyping,
          (e) => {
            setTypers((prev) => {
              const next = new Map(prev);
              next.set(e.payload.user.id, {
                username: e.payload.user.username,
                expiresAt: e.payload.expiresAt,
              });
              return next;
            });
          },
          opts,
        ),
        await listen<NudgePayload>(
          EVT.IncomingNudge,
          () => {
            setShaking(true);
            window.setTimeout(() => setShaking(false), SHAKE_DURATION_MS);
            if (!mutedRef.current) playNudge();
            void flashWindowIfUnfocused();
          },
          opts,
        ),
        await listen<MembersChangedPayload>(
          EVT.MembersChanged,
          (e) => {
            setConv((prev) =>
              prev ? { ...prev, members: e.payload.members } : prev,
            );
          },
          opts,
        ),
        await listen<ConvUpdatedPayload>(
          EVT.ConvUpdated,
          (e) => {
            if (e.payload.conv.id !== convID) return;
            setConv(e.payload.conv);
          },
          opts,
        ),
        await listen<{ muted: boolean }>(
          EVT.MutedChanged,
          (e) => {
            setMuted(e.payload.muted);
          },
          opts,
        ),
        await listen<{ muted: boolean }>(
          EVT.ConvMuteChanged,
          (e) => {
            setConvMuted(e.payload.muted);
          },
          opts,
        ),
        await listen<ReadReceiptPayload>(
          EVT.IncomingReadReceipt,
          (e) => {
            setReads((prev) => {
              const current = prev.get(e.payload.user_id) ?? 0;
              if (e.payload.last_read_message_id <= current) return prev;
              const next = new Map(prev);
              next.set(e.payload.user_id, e.payload.last_read_message_id);
              return next;
            });
          },
          opts,
        ),
        await listen<ReactionPayload>(
          EVT.IncomingReaction,
          (e) => {
            setReactions((prev) => {
              const current = prev.get(e.payload.message_id) ?? [];
              const next = applyReactionDelta(
                current,
                e.payload.user_id,
                e.payload.emoji,
                e.payload.action,
              );
              const out = new Map(prev);
              if (next.length === 0) {
                out.delete(e.payload.message_id);
              } else {
                out.set(e.payload.message_id, next);
              }
              return out;
            });
          },
          opts,
        ),
        await listen<MessageEditedPayload>(
          EVT.IncomingMessageEdited,
          (e) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === e.payload.message_id
                  ? { ...m, body: e.payload.body, edited_at: e.payload.edited_at }
                  : m,
              ),
            );
          },
          opts,
        ),
        await listen<MessageDeletedPayload>(
          EVT.IncomingMessageDeleted,
          (e) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === e.payload.message_id
                  ? { ...m, body: "", deleted_at: e.payload.deleted_at }
                  : m,
              ),
            );
          },
          opts,
        ),
        await listen<UserUpdatedPayload>(
          EVT.UserUpdated,
          (e) => {
            setUserCache((prev) => {
              const next = new Map(prev);
              next.set(e.payload.user.id, e.payload.user);
              return next;
            });
            // Also update the conv's stored member list, since chat
            // windows derive titles/headers from it.
            setConv((prev) => {
              if (!prev) return prev;
              const idx = prev.members.findIndex(
                (m) => m.id === e.payload.user.id,
              );
              if (idx === -1) return prev;
              const members = [...prev.members];
              members[idx] = e.payload.user;
              return { ...prev, members };
            });
          },
          opts,
        ),
      );
      if (cancelled) {
        for (const u of unlisteners) u();
        return;
      }
      // Now that we can receive, ask main for the initial state.
      void emit(EVT.Ready, { conversation_id: convID });
    }
    void setup();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, [convID]);

  // ---- typing expiry tick ------------------------------------------

  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setTypers((prev) => {
        let dirty = false;
        const next = new Map(prev);
        for (const [k, v] of prev.entries()) {
          if (v.expiresAt <= now) {
            next.delete(k);
            dirty = true;
          }
        }
        return dirty ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  // ---- window title + focus → unread clear --------------------------

  useEffect(() => {
    if (!conv || !session) return;
    void setWindowTitle(conversationTitle(conv, session.user.id));
  }, [conv, session]);

  useEffect(() => {
    const w = getCurrentWindow();
    let unlisten: UnlistenFn | undefined;
    // Fire-once on mount so main knows about our starting focus state
    // (windows are spawned focused).
    void w.isFocused().then((focused) => {
      void emit(EVT.Focused, { conversation_id: convID, focused });
    });
    void w
      .onFocusChanged(({ payload: focused }) => {
        void emit(EVT.Focused, { conversation_id: convID, focused });
      })
      .then((u) => {
        unlisten = u;
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, [convID]);

  // ---- render -------------------------------------------------------

  if (!session || !conv) {
    return (
      <main className="phase6 chat-window-app">
        <p className="empty">Loading…</p>
      </main>
    );
  }

  return (
    <ChatBody
      session={session}
      conv={conv}
      convID={convID}
      messages={messages}
      typers={Array.from(typers.values())}
      shaking={shaking}
      reads={reads}
      reactions={reactions}
      userCache={userCache}
      convMuted={convMuted}
    />
  );
}

// applyReactionDelta — same logic as the App.tsx mergeReaction helper;
// duplicated here so the chat-window bundle stays independent.
function applyReactionDelta(
  current: ReactionGroup[],
  userID: number,
  emoji: string,
  action: "add" | "remove",
): ReactionGroup[] {
  const out = current.map((g) => ({ emoji: g.emoji, user_ids: [...g.user_ids] }));
  const idx = out.findIndex((g) => g.emoji === emoji);
  if (action === "add") {
    if (idx === -1) {
      out.push({ emoji, user_ids: [userID] });
    } else if (!out[idx].user_ids.includes(userID)) {
      out[idx].user_ids.push(userID);
    }
  } else {
    if (idx === -1) return out;
    out[idx].user_ids = out[idx].user_ids.filter((id) => id !== userID);
    if (out[idx].user_ids.length === 0) out.splice(idx, 1);
  }
  out.sort((a, b) => (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0));
  return out;
}

// ChatBody owns the composer state (draft text, pending attachments).
// Split out so the parent doesn't re-render the composer's local state
// on every incoming message.
function ChatBody({
  session,
  conv,
  convID,
  messages,
  typers,
  shaking,
  reads,
  reactions,
  userCache,
  convMuted,
}: {
  session: SessionSnapshot;
  conv: ConversationView;
  convID: number;
  messages: MessageView[];
  typers: { username: string; expiresAt: number }[];
  shaking: boolean;
  reads: Map<number, number>;
  reactions: Map<number, ReactionGroup[]>;
  userCache: Map<number, UserInfo>;
  convMuted: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [nudgeCooldown, setNudgeCooldown] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Editing state: when non-null, the composer replaces "send" with
  // "save edit" and operates on this message id instead of creating
  // a new one.
  const [editing, setEditing] = useState<MessageView | null>(null);
  // Reply target: when non-null, the composer shows a quote pill and
  // outgoing messages are sent with reply_to_id set.
  const [replyTarget, setReplyTarget] = useState<MessageView | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastTypingSentAt = useRef(0);

  const sendReact = useCallback(
    (messageID: number, emoji: string) => {
      void emit(EVT.OutgoingReact, {
        conversation_id: convID,
        message_id: messageID,
        emoji,
      });
    },
    [convID],
  );

  const sendEditOut = useCallback(
    (messageID: number, body: string) => {
      void emit(EVT.OutgoingEdit, {
        conversation_id: convID,
        message_id: messageID,
        body,
      });
    },
    [convID],
  );

  const sendDeleteOut = useCallback(
    (messageID: number) => {
      void emit(EVT.OutgoingDelete, {
        conversation_id: convID,
        message_id: messageID,
      });
    },
    [convID],
  );

  function startEdit(m: MessageView) {
    setEditing(m);
    setReplyTarget(null);
    setDraft(m.body);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
  }

  function startReply(m: MessageView) {
    setReplyTarget(m);
    setEditing(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelReply() {
    setReplyTarget(null);
  }

  function insertEmojiInDraft(glyph: string) {
    const el = inputRef.current;
    if (!el) {
      setDraft((d) => d + glyph);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + glyph + draft.slice(end);
    setDraft(next);
    // Restore cursor after the inserted glyph on next tick.
    requestAnimationFrame(() => {
      const pos = start + glyph.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const sendOut = useCallback(
    (body: string, attachmentIDs?: number[], replyToID?: number) => {
      void emit(EVT.Send, {
        conversation_id: convID,
        body,
        attachment_ids: attachmentIDs,
        reply_to_id: replyToID,
      });
    },
    [convID],
  );

  const sendTyping = useCallback(() => {
    void emit(EVT.OutgoingTyping, { conversation_id: convID });
  }, [convID]);

  const sendNudgeOut = useCallback(() => {
    void emit(EVT.OutgoingNudge, { conversation_id: convID });
  }, [convID]);

  const sendLeave = useCallback(() => {
    void emit(EVT.Leave, { conversation_id: convID });
    // The main window will close us via window.close(); no need to
    // call close() ourselves and risk a double-fire.
  }, [convID]);

  function handleNudgeClick() {
    if (nudgeCooldown) return;
    sendNudgeOut();
    setNudgeCooldown(true);
    window.setTimeout(() => setNudgeCooldown(false), NUDGE_COOLDOWN_MS);
  }

  const uploading = pending.some((p) => p.kind === "uploading");
  const readyIDs = pending
    .filter(
      (p): p is { kind: "ready"; localID: string; view: AttachmentView } =>
        p.kind === "ready",
    )
    .map((p) => p.view.id);

  async function handleFiles(files: FileList) {
    for (const file of Array.from(files)) {
      const localID = cryptoRandomID();
      setPending((p) => [
        ...p,
        { kind: "uploading", localID, filename: file.name },
      ]);
      try {
        const view = await uploadFile(session.serverUrl, session.token, file);
        setPending((p) =>
          p.map((x) =>
            x.localID === localID ? { kind: "ready", localID, view } : x,
          ),
        );
      } catch (err) {
        setPending((p) =>
          p.map((x) =>
            x.localID === localID
              ? {
                  kind: "error",
                  localID,
                  filename: file.name,
                  error: (err as Error).message,
                }
              : x,
          ),
        );
      }
    }
  }

  function removePending(localID: string) {
    setPending((p) => p.filter((x) => x.localID !== localID));
  }

  // Drag-and-drop: dropping files anywhere in the chat-window body
  // routes them through the same upload flow as the paperclip.
  const [dragOver, setDragOver] = useState(false);
  function onDragOver(e: React.DragEvent<HTMLElement>) {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }
  function onDragLeave(e: React.DragEvent<HTMLElement>) {
    if (e.currentTarget === e.target) setDragOver(false);
  }
  function onDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  // Paste handler — clipboard images go straight into the upload queue.
  // Text pastes are left alone (caller's default paste behaviour).
  function onPaste(e: React.ClipboardEvent<HTMLElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      void handleFiles(dt.files);
    }
  }

  function trySend() {
    let body = draft.trim();
    if (uploading) return;
    // Editing path: send an edit instead of a new message.
    if (editing) {
      if (!body) return;
      // Re-run slash expansion on edits too so users can /shrug a
      // typo-fix into shape.
      body = expandSlashCommand(body).body;
      sendEditOut(editing.id, body);
      cancelEdit();
      return;
    }
    if (!body && readyIDs.length === 0) return;
    // Slash commands run before the network hop. Unrecognised ones
    // pass through unchanged (handled=false).
    if (body) body = expandSlashCommand(body).body;
    sendOut(
      body,
      readyIDs.length > 0 ? readyIDs : undefined,
      replyTarget?.id,
    );
    setDraft("");
    setPending((p) => p.filter((x) => x.kind === "uploading"));
    setReplyTarget(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trySend();
      return;
    }
    if (e.key === "Escape") {
      if (editing) {
        e.preventDefault();
        cancelEdit();
      } else if (replyTarget) {
        e.preventDefault();
        cancelReply();
      }
    }
  }

  const title = conversationTitle(conv, session.user.id);
  const subtitle = conversationSubtitle(conv, session.user.id);

  return (
    <main
      className={`phase6 chat-window-app ${shaking ? "shaking" : ""} ${dragOver ? "drag-over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <header className="chat-window-app-header">
        <div className="chat-window-titles">
          <span className="chat-window-title">{title}</span>
          {subtitle && (
            <span className="chat-window-subtitle">{subtitle}</span>
          )}
        </div>
        <div className="chat-window-buttons">
          <button
            type="button"
            className="chat-window-button"
            title={convMuted ? "Unmute conversation" : "Mute conversation"}
            onClick={() =>
              void emit(EVT.ToggleConvMute, { conversation_id: convID })
            }
          >
            {convMuted ? "🔕" : "🔔"}
          </button>
          <button
            type="button"
            className="chat-window-button"
            title={nudgeCooldown ? "Wait a moment…" : "Nudge"}
            onClick={handleNudgeClick}
            disabled={nudgeCooldown}
          >
            👋
          </button>
          {conv.type !== "dm" && (
            <button
              type="button"
              className="chat-window-button danger"
              title={`Leave ${title}`}
              onClick={() => {
                if (confirm(`Leave ${title}?`)) sendLeave();
              }}
            >
              Leave
            </button>
          )}
        </div>
      </header>

      <div className="chat-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="empty">No messages yet — say hi.</p>
        ) : (
          messages.map((m) => (
            <MessageRow
              key={m.id}
              m={m}
              session={session}
              conv={conv}
              reads={reads}
              reactions={reactions.get(m.id) ?? []}
              userCache={userCache}
              onReact={(emoji) => sendReact(m.id, emoji)}
              onReply={() => startReply(m)}
              onEdit={() => startEdit(m)}
              onDelete={() => {
                if (confirm("Delete this message?")) sendDeleteOut(m.id);
              }}
            />
          ))
        )}
      </div>

      {typers.length > 0 && (
        <div className="typing-indicator">
          {formatTypers(typers.map((t) => t.username))} typing…
        </div>
      )}

      {editing && (
        <div className="composer-context editing">
          <span>
            Editing message — press <kbd>Esc</kbd> to cancel
          </span>
          <button type="button" onClick={cancelEdit}>
            ×
          </button>
        </div>
      )}
      {!editing && replyTarget && (
        <div className="composer-context replying">
          <span className="composer-context-quote">
            Replying to{" "}
            <strong>{displayNameOf(userCache.get(replyTarget.sender.id) ?? replyTarget.sender)}</strong>
            : {truncate(replyTarget.body || "(attachment)", 80)}
          </span>
          <button type="button" onClick={cancelReply}>
            ×
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <div className="composer-pending">
          {pending.map((p) => (
            <PendingChip
              key={p.localID}
              attachment={p}
              onRemove={() => removePending(p.localID)}
            />
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          trySend();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) {
              void handleFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <button
          type="button"
          className="composer-attach"
          onClick={() => fileInputRef.current?.click()}
          title="Attach a file"
        >
          📎
        </button>
        <div className="composer-emoji-wrap">
          <button
            type="button"
            className="composer-attach"
            onClick={() => setEmojiOpen((v) => !v)}
            title="Insert emoji"
          >
            😀
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(glyph) => {
                insertEmojiInDraft(glyph);
                setEmojiOpen(false);
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value !== "") {
              const now = Date.now();
              if (now - lastTypingSentAt.current >= TYPING_SEND_THROTTLE_MS) {
                lastTypingSentAt.current = now;
                sendTyping();
              }
            }
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a message — Enter to send"
          maxLength={4096}
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={uploading || (!draft.trim() && readyIDs.length === 0)}
        >
          {uploading ? "…" : editing ? "Save" : "Send"}
        </button>
      </form>
    </main>
  );
}

// ---- presentational helpers (duplicated from App.tsx to keep the
//      chat window's bundle independent — these are tiny pure fns) ----

function MessageRow({
  m,
  session,
  conv,
  reads,
  reactions,
  userCache,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: {
  m: MessageView;
  session: SessionSnapshot;
  conv: ConversationView;
  reads: Map<number, number>;
  reactions: ReactionGroup[];
  userCache: Map<number, UserInfo>;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mine = m.sender.id === session.user.id;
  const sender = userCache.get(m.sender.id) ?? m.sender;
  const isDeleted = !!m.deleted_at;
  const isEdited = !!m.edited_at;
  // Edit window is 15 min — match the server. We don't block clicks
  // past the window (server enforces), but greying out is gentler.
  const editable =
    mine &&
    !isDeleted &&
    Date.now() - new Date(m.created_at).getTime() < 15 * 60 * 1000;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFlipUp, setPickerFlipUp] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Open picker — flip upward if there isn't enough room below.
  function openPicker() {
    const tb = toolbarRef.current;
    if (tb) {
      const rect = tb.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      // EmojiPicker is ~280 px tall when fully expanded.
      setPickerFlipUp(spaceBelow < 300);
    }
    setPickerOpen(true);
  }
  return (
    <div className={`msg ${mine ? "msg-mine" : ""}`}>
      <div className="msg-row">
        {!mine && (
          <Avatar
            user={sender}
            serverUrl={session.serverUrl}
            token={session.token}
            size={28}
            className="msg-avatar"
          />
        )}
        <div className="msg-bubble">
          {m.reply_to && (
            <ReplyQuote snippet={m.reply_to} userCache={userCache} />
          )}
          <div className="msg-meta">
            <span className="msg-sender">
              {mine ? "you" : displayNameOf(sender)}
            </span>
            <span className="msg-time">{formatTime(m.created_at)}</span>
          </div>
          {isDeleted ? (
            <div className="msg-body msg-deleted">this message was deleted</div>
          ) : m.body ? (
            <div className="msg-body">
              {m.body}
              {isEdited && <span className="msg-edited"> (edited)</span>}
            </div>
          ) : null}
          {m.attachments && m.attachments.length > 0 && (
            <div className="msg-attachments">
              {m.attachments.map((a) => (
                <AttachmentRender key={a.id} a={a} session={session} />
              ))}
            </div>
          )}
          {reactions.length > 0 && (
            <div className="msg-reactions">
              {reactions.map((g) => {
                const isMyReaction = g.user_ids.includes(session.user.id);
                const names = g.user_ids
                  .map((uid) => userCache.get(uid))
                  .filter((u): u is UserInfo => u !== undefined)
                  .map(displayNameOf)
                  .join(", ");
                return (
                  <button
                    key={g.emoji}
                    type="button"
                    className={`msg-reaction ${isMyReaction ? "mine" : ""}`}
                    title={names || `${g.user_ids.length} reactions`}
                    onClick={() => onReact(g.emoji)}
                  >
                    <span>{g.emoji}</span>
                    <span>{g.user_ids.length}</span>
                  </button>
                );
              })}
            </div>
          )}
          {mine && (
            <ReadTicks m={m} conv={conv} reads={reads} self={session.user} />
          )}
        </div>
        <div className="msg-toolbar" ref={toolbarRef}>
          {!isDeleted &&
            QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="msg-toolbar-btn"
                title={`React with ${emoji}`}
                onClick={() => onReact(emoji)}
              >
                {emoji}
              </button>
            ))}
          {!isDeleted && (
            <button
              type="button"
              className="msg-toolbar-btn"
              title="More reactions"
              onClick={() =>
                pickerOpen ? setPickerOpen(false) : openPicker()
              }
            >
              ⊕
            </button>
          )}
          {!isDeleted && (
            <button
              type="button"
              className="msg-toolbar-btn"
              title="Reply"
              onClick={onReply}
            >
              ↩
            </button>
          )}
          {editable && (
            <button
              type="button"
              className="msg-toolbar-btn"
              title="Edit (15 min window)"
              onClick={onEdit}
            >
              ✏️
            </button>
          )}
          {mine && !isDeleted && (
            <button
              type="button"
              className="msg-toolbar-btn danger"
              title="Delete"
              onClick={onDelete}
            >
              🗑
            </button>
          )}
          {pickerOpen && (
            <div
              className={`msg-toolbar-picker ${pickerFlipUp ? "flip-up" : ""}`}
            >
              <EmojiPicker
                onPick={(glyph) => {
                  onReact(glyph);
                  setPickerOpen(false);
                }}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ReadTicks renders the single ✓ (delivered) or double ✓✓ (read) under
// own messages. For groups, hovering shows "Read by Alice, Bob (2/3)".
function ReadTicks({
  m,
  conv,
  reads,
  self,
}: {
  m: MessageView;
  conv: ConversationView;
  reads: Map<number, number>;
  self: UserInfo;
}) {
  const others = conv.members.filter((u) => u.id !== self.id);
  if (others.length === 0) return null;
  const readers = others.filter((u) => (reads.get(u.id) ?? 0) >= m.id);
  const isDM = conv.type === "dm";

  if (readers.length === 0) {
    return (
      <span className="msg-ticks msg-ticks-sent" title="Sent">
        ✓
      </span>
    );
  }
  const all = readers.length === others.length;
  const tooltip = isDM
    ? "Read"
    : all
      ? `Read by all (${readers.length}/${others.length})`
      : `Read by ${readers.map((r) => r.username).join(", ")} (${readers.length}/${others.length})`;
  return (
    <span
      className={`msg-ticks ${all ? "msg-ticks-read" : "msg-ticks-partial"}`}
      title={tooltip}
    >
      ✓✓
      {!isDM && !all && (
        <span className="msg-ticks-count">
          {readers.length}/{others.length}
        </span>
      )}
    </span>
  );
}

// ReplyQuote renders the small "↪ Alice: short preview…" header at
// the top of a reply bubble. If the original was deleted the body is
// suppressed and we just render the tomb-stoned hint.
function ReplyQuote({
  snippet,
  userCache,
}: {
  snippet: ReplySnippet;
  userCache: Map<number, UserInfo>;
}) {
  const sender = userCache.get(snippet.sender.id) ?? snippet.sender;
  return (
    <div className="msg-quote" title={snippet.deleted ? "Deleted message" : snippet.body}>
      <span className="msg-quote-arrow">↪</span>
      <span className="msg-quote-sender">{displayNameOf(sender)}</span>
      <span className="msg-quote-body">
        {snippet.deleted ? "(deleted message)" : truncate(snippet.body, 80)}
      </span>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function AttachmentRender({
  a,
  session,
}: {
  a: AttachmentView;
  session: SessionSnapshot;
}) {
  const url = fileURL(session.serverUrl, session.token, a.id);
  const [lightbox, setLightbox] = useState(false);
  if (a.mime_type.startsWith("image/")) {
    return (
      <>
        <button
          type="button"
          className="msg-image-link"
          onClick={() => setLightbox(true)}
          title={`${a.filename} (${formatBytes(a.size_bytes)})`}
        >
          <img
            className="msg-image"
            src={url}
            alt={a.filename}
            loading="lazy"
            draggable={false}
          />
        </button>
        {lightbox && (
          <ImageLightbox
            url={url}
            alt={a.filename}
            onClose={() => setLightbox(false)}
          />
        )}
      </>
    );
  }
  return (
    <a className="msg-file" href={url} download={a.filename} title={a.filename}>
      <span className="msg-file-icon">📎</span>
      <span className="msg-file-name">{a.filename}</span>
      <span className="msg-file-size">{formatBytes(a.size_bytes)}</span>
    </a>
  );
}

// ImageLightbox — full-window image viewer for inline attachments.
// Escape or click on the backdrop closes; click on the image itself
// is absorbed so users don't accidentally dismiss while panning.
function ImageLightbox({
  url,
  alt,
  onClose,
}: {
  url: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="image-lightbox" onClick={onClose}>
      <img
        src={url}
        alt={alt}
        className="image-lightbox-img"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>
  );
}

function PendingChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  let label: string;
  let cls: string;
  switch (attachment.kind) {
    case "uploading":
      label = `Uploading ${attachment.filename}…`;
      cls = "chip-uploading";
      break;
    case "ready":
      label = `${attachment.view.filename} (${formatBytes(attachment.view.size_bytes)})`;
      cls = "chip-ready";
      break;
    case "error":
      label = `Failed: ${attachment.filename} — ${attachment.error}`;
      cls = "chip-error";
      break;
  }
  return (
    <span className={`chip ${cls}`}>
      <span>{label}</span>
      <button type="button" onClick={onRemove} title="Remove">
        ×
      </button>
    </span>
  );
}

function conversationTitle(conv: ConversationView, selfID: number): string {
  if (conv.type === "dm") {
    const other = conv.members.find((m) => m.id !== selfID);
    return other ? other.username : `DM #${conv.id}`;
  }
  if (conv.name) return conv.name;
  if (conv.type === "group") return "Unnamed group";
  return `Room #${conv.id}`;
}

function conversationSubtitle(
  conv: ConversationView,
  selfID: number,
): string | null {
  if (conv.type === "dm") return null;
  if (conv.type === "room" && conv.topic) {
    return `${conv.topic} — ${conv.members.length} member${
      conv.members.length === 1 ? "" : "s"
    }`;
  }
  const names = conv.members
    .filter((m) => m.id !== selfID)
    .map((m) => m.username)
    .join(", ");
  return names ? `${conv.members.length} members: you, ${names}` : "Just you";
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function cryptoRandomID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTypers(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more are`;
}


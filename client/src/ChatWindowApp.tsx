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
  type MembersChangedPayload,
  type ConvUpdatedPayload,
  type MessageView,
  type NudgePayload,
  type SessionSnapshot,
  type TypingPayload,
} from "./lib/chatBridge";

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

  // Use refs so the listen()-callbacks (set up once) can see the latest
  // session/muted without re-subscribing.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

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
            // Defensive: ignore a hydrate intended for some other conv.
            if (e.payload.conv.id !== convID) return;
            setSession(e.payload.session);
            setConv(e.payload.conv);
            setMessages([...e.payload.messages].sort((a, b) => a.id - b.id));
            setTypers(
              new Map(e.payload.typers.map((t, i) => [-1 - i, t])),
            );
            setMuted(e.payload.muted);
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
            const me = sessionRef.current;
            if (me && m.sender.id !== me.user.id && !mutedRef.current) {
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
    />
  );
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
}: {
  session: SessionSnapshot;
  conv: ConversationView;
  convID: number;
  messages: MessageView[];
  typers: { username: string; expiresAt: number }[];
  shaking: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [nudgeCooldown, setNudgeCooldown] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTypingSentAt = useRef(0);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const sendOut = useCallback(
    (body: string, attachmentIDs?: number[]) => {
      void emit(EVT.Send, {
        conversation_id: convID,
        body,
        attachment_ids: attachmentIDs,
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

  function trySend() {
    const body = draft.trim();
    if (!body && readyIDs.length === 0) return;
    if (uploading) return;
    sendOut(body, readyIDs.length > 0 ? readyIDs : undefined);
    setDraft("");
    setPending((p) => p.filter((x) => x.kind === "uploading"));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  }

  const title = conversationTitle(conv, session.user.id);
  const subtitle = conversationSubtitle(conv, session.user.id);

  return (
    <main className={`phase6 chat-window-app ${shaking ? "shaking" : ""}`}>
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
            <MessageRow key={m.id} m={m} session={session} />
          ))
        )}
      </div>

      {typers.length > 0 && (
        <div className="typing-indicator">
          {formatTypers(typers.map((t) => t.username))} typing…
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
        <input
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
          {uploading ? "…" : "Send"}
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
}: {
  m: MessageView;
  session: SessionSnapshot;
}) {
  const mine = m.sender.id === session.user.id;
  return (
    <div className={`msg ${mine ? "msg-mine" : ""}`}>
      <div className="msg-meta">
        <span className="msg-sender">{mine ? "you" : m.sender.username}</span>
        <span className="msg-time">{formatTime(m.created_at)}</span>
      </div>
      {m.body && <div className="msg-body">{m.body}</div>}
      {m.attachments && m.attachments.length > 0 && (
        <div className="msg-attachments">
          {m.attachments.map((a) => (
            <AttachmentRender key={a.id} a={a} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentRender({
  a,
  session,
}: {
  a: AttachmentView;
  session: SessionSnapshot;
}) {
  const url = fileURL(session.serverUrl, session.token, a.id);
  if (a.mime_type.startsWith("image/")) {
    return (
      <a
        className="msg-image-link"
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${a.filename} (${formatBytes(a.size_bytes)})`}
      >
        <img className="msg-image" src={url} alt={a.filename} loading="lazy" />
      </a>
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


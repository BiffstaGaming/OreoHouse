import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  emitTo,
  listen,
  TauriEvent,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows } from "@tauri-apps/api/window";

import {
  ApiError,
  createDM,
  createGroup,
  createRoom,
  httpToWs,
  joinRoom,
  leaveConversation,
  listConversations,
  listMessages,
  listRooms,
  login,
  logout,
} from "./lib/api";
import {
  EVT,
  type ChatToMainEnvelope,
  type ConvUpdatedPayload,
  type HydratePayload,
  type MembersChangedPayload,
  type MessagePayload,
  type NudgePayload,
  type SendPayload,
  type SessionSnapshot,
  type TypingPayload,
} from "./lib/chatBridge";
import {
  clearSession as clearStoredSession,
  loadLastServerUrl,
  loadSession,
  saveLastServerUrl,
  saveSession,
} from "./lib/session";
import {
  isMuted as isMutedPersisted,
  playMessageBlip,
  playNudge,
  setMuted as setMutedPersisted,
} from "./lib/sounds";
import {
  flashWindowIfUnfocused,
  setWindowTitle,
} from "./lib/tauri";
import { connect, type ConnectionStatus, type WSClient } from "./lib/ws";
import type {
  ConversationView,
  MessageView,
  OutgoingMessage,
  PresenceInfo,
  RoomView,
  ServerMessage,
  UserInfo,
  UserState,
} from "./types/proto";

import "./App.css";

type Session = SessionSnapshot;

type ModalKind = "newGroup" | "newRoom" | "browseRooms";

const DEFAULT_SERVER_URL = "http://localhost:8080";
const HISTORY_PAGE_SIZE = 50;
const CHAT_WINDOW_DEFAULT = { w: 420, h: 520 };
const CHAT_WINDOW_MIN = { w: 320, h: 280 };
const TYPING_EXPIRY_MS = 5000;

// Per-conversation window geometry persisted in localStorage so a chat
// pops back up at the size + position you last left it.
type Geometry = { x: number; y: number; w: number; h: number };

function geomKey(convID: number): string {
  return `oreohouse-chat-geom-${convID}`;
}

function loadGeometry(convID: number): Geometry | null {
  try {
    const raw = localStorage.getItem(geomKey(convID));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Geometry>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.w === "number" &&
      typeof parsed.h === "number" &&
      parsed.w >= CHAT_WINDOW_MIN.w &&
      parsed.h >= CHAT_WINDOW_MIN.h
    ) {
      return parsed as Geometry;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export default function App() {
  // Auto-resume from a persisted session if we have one. The token is
  // validated implicitly on the first authenticated REST call — a 401
  // there clears storage and bounces us back to login.
  const [session, setSession] = useState<Session | null>(() => loadSession());

  function handleSession(s: Session) {
    saveSession(s);
    saveLastServerUrl(s.serverUrl);
    setSession(s);
  }

  function handleClearSession() {
    clearStoredSession();
    setSession(null);
  }

  if (!session) {
    return <LoginScreen onSession={handleSession} />;
  }
  return <ChatScreen session={session} onSignOut={handleClearSession} />;
}

// ---------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------

function LoginScreen({ onSession }: { onSession: (s: Session) => void }) {
  // Pre-fill the server URL from the last successful login, falling
  // back to the dev default for a fresh install.
  const [serverUrl, setServerUrl] = useState(
    () => loadLastServerUrl() ?? DEFAULT_SERVER_URL,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const resp = await login(serverUrl, { username, password });
      setPassword("");
      onSession({ serverUrl, token: resp.token, user: resp.user });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="phase6 login-screen">
      <h1>OreoHouse</h1>
      <p className="subtitle">Sign in to your family server.</p>
      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          Server URL
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------
// Chat screen — top-level container
// ---------------------------------------------------------------------
//
// Owns:
//   - the WebSocket connection
//   - the conversations + messages caches
//   - the unread-per-conv badges
//   - the list of currently-open chat sub-windows (Tauri labels)
//
// Each chat window is a real OS window spawned via Tauri. The chat
// window's React root is in ChatWindowApp.tsx; main ↔ chat traffic
// uses the events defined in lib/chatBridge.ts.

function ChatScreen({
  session,
  onSignOut,
}: {
  session: Session;
  onSignOut: () => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [online, setOnline] = useState<PresenceInfo[]>([]);
  const [myState, setMyState] = useState<UserState>("online");
  const [myCustomText, setMyCustomText] = useState<string>("");
  const [conversations, setConversations] = useState<
    Map<number, ConversationView>
  >(new Map());
  const [messages, setMessages] = useState<Map<number, MessageView[]>>(
    new Map(),
  );
  const [unreadByConv, setUnreadByConv] = useState<Map<number, number>>(
    new Map(),
  );
  // Per-conversation typing indicators. Inner map: user_id →
  // {username, expiresAt}.
  const [typing, setTyping] = useState<
    Map<number, Map<number, { username: string; expiresAt: number }>>
  >(new Map());
  const [muted, setMutedState] = useState<boolean>(() => isMutedPersisted());
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [historyLoading, setHistoryLoading] = useState<Set<number>>(new Set());
  const wsRef = useRef<WSClient | null>(null);

  // Open chat sub-windows by conv id. The value is the Tauri label.
  // Kept in a ref because the listen()-callbacks need it without
  // re-subscribing on every change.
  const openChatsRef = useRef<Set<number>>(new Set());
  // Which chat sub-window (if any) currently has the OS focus. Used by
  // appendMessage to decide whether to bump the unread badge.
  const focusedConvRef = useRef<number | null>(null);

  // Refs mirroring state for use inside listen() callbacks.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const typingRef = useRef(typing);
  typingRef.current = typing;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  function toggleMuted() {
    setMutedState((prev) => {
      const next = !prev;
      setMutedPersisted(next);
      // Broadcast to chat windows so their per-window mute toggle stays
      // in sync without each one re-reading localStorage.
      for (const id of openChatsRef.current) {
        void emitTo(`chat-${id}`, EVT.MutedChanged, { muted: next });
      }
      return next;
    });
  }

  const refreshConversations = useCallback(async () => {
    try {
      const convs = await listConversations(session.serverUrl, session.token);
      setConversations(new Map(convs.map((c) => [c.id, c])));
    } catch (err) {
      // If the persisted token has been revoked / expired (or the
      // server has been rebuilt and lost our session row), bounce back
      // to login so the user can re-authenticate instead of staring at
      // an empty contact list.
      if (err instanceof ApiError && err.status === 401) {
        console.warn("session rejected by server, signing out");
        onSignOut();
        return;
      }
      console.error("listConversations failed:", err);
    }
  }, [session, onSignOut]);

  // ---- WebSocket connect ------------------------------------------

  useEffect(() => {
    void refreshConversations();

    let wsUrl: string;
    try {
      wsUrl = httpToWs(session.serverUrl, session.token);
    } catch (err) {
      console.error("bad server URL", err);
      setStatus("error");
      return;
    }
    setStatus("connecting");
    const client = connect(wsUrl, {
      onOpen: () => setStatus("open"),
      onMessage: handleServerMessage,
      onClose: () => setStatus("closed"),
      onError: () => setStatus("error"),
    });
    wsRef.current = client;
    return () => {
      client.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ---- chat-window IPC: chat → main -------------------------------

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    async function setup() {
      unlisteners.push(
        await listen<ChatToMainEnvelope<{}>>(EVT.Ready, async (e) => {
          const cid = e.payload.conversation_id;
          await ensureHistory(cid);
          const conv = conversationsRef.current.get(cid);
          if (!conv) return;
          const hydrate: HydratePayload = {
            session: sessionRef.current,
            conv,
            messages: messagesRef.current.get(cid) ?? [],
            typers: Array.from(
              (typingRef.current.get(cid) ?? new Map()).values(),
            ),
            muted: mutedRef.current,
          };
          await emitTo(`chat-${cid}`, EVT.Hydrate, hydrate);
        }),
        await listen<ChatToMainEnvelope<SendPayload>>(EVT.Send, (e) => {
          if (!wsRef.current) return;
          wsRef.current.send({
            type: "message",
            conversation_id: e.payload.conversation_id,
            body: e.payload.body,
            attachment_ids: e.payload.attachment_ids,
          });
        }),
        await listen<ChatToMainEnvelope<{}>>(EVT.OutgoingTyping, (e) => {
          if (!wsRef.current) return;
          wsRef.current.send({
            type: "typing",
            conversation_id: e.payload.conversation_id,
          });
        }),
        await listen<ChatToMainEnvelope<{}>>(EVT.OutgoingNudge, (e) => {
          if (!wsRef.current) return;
          wsRef.current.send({
            type: "nudge",
            conversation_id: e.payload.conversation_id,
          });
        }),
        await listen<ChatToMainEnvelope<{ focused: boolean }>>(
          EVT.Focused,
          (e) => {
            const cid = e.payload.conversation_id;
            if (e.payload.focused) {
              focusedConvRef.current = cid;
              // Clear unread the moment the conv comes into focus.
              setUnreadByConv((prev) => {
                if (!prev.has(cid)) return prev;
                const out = new Map(prev);
                out.delete(cid);
                return out;
              });
            } else if (focusedConvRef.current === cid) {
              focusedConvRef.current = null;
            }
          },
        ),
        await listen<ChatToMainEnvelope<{}>>(EVT.Leave, (e) => {
          const conv = conversationsRef.current.get(e.payload.conversation_id);
          if (conv) void handleLeave(conv);
        }),
      );
      if (cancelled) {
        for (const u of unlisteners) u();
      }
    }
    void setup();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- WS server message handler -----------------------------------

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome":
        setOnline(sortPresence(msg.online));
        {
          const me = msg.online.find((p) => p.user.id === session.user.id);
          if (me) {
            setMyState(me.state);
            setMyCustomText(me.custom_text ?? "");
          }
        }
        return;
      case "presence":
        setOnline((prev) => {
          if (msg.state === "offline") {
            return prev.filter((p) => p.user.id !== msg.user.id);
          }
          const next = prev.filter((p) => p.user.id !== msg.user.id);
          next.push({
            user: msg.user,
            state: msg.state,
            custom_text: msg.custom_text,
          });
          return sortPresence(next);
        });
        if (msg.user.id === session.user.id && msg.state !== "offline") {
          setMyState(msg.state);
          setMyCustomText(msg.custom_text ?? "");
        }
        return;
      case "message":
        appendMessage(msg);
        return;
      case "conversation_added":
        setConversations((prev) => {
          const out = new Map(prev);
          out.set(msg.conversation.id, msg.conversation);
          return out;
        });
        // If a chat window happens to be open for this conv (shouldn't
        // be, but be defensive), let it refresh.
        if (openChatsRef.current.has(msg.conversation.id)) {
          const payload: ConvUpdatedPayload = { conv: msg.conversation };
          void emitTo(`chat-${msg.conversation.id}`, EVT.ConvUpdated, payload);
        }
        return;
      case "typing":
        if (msg.user.id === session.user.id) return;
        setTyping((prev) => {
          const out = new Map(prev);
          const inner = new Map(out.get(msg.conversation_id) ?? new Map());
          inner.set(msg.user.id, {
            username: msg.user.username,
            expiresAt: Date.now() + TYPING_EXPIRY_MS,
          });
          out.set(msg.conversation_id, inner);
          return out;
        });
        if (openChatsRef.current.has(msg.conversation_id)) {
          const payload: TypingPayload = {
            user: msg.user,
            expiresAt: Date.now() + TYPING_EXPIRY_MS,
          };
          void emitTo(
            `chat-${msg.conversation_id}`,
            EVT.IncomingTyping,
            payload,
          );
        }
        return;
      case "nudge":
        triggerNudgeReceived(msg.conversation_id, msg.sender);
        return;
      case "conversation_members_changed":
        setConversations((prev) => {
          const existing = prev.get(msg.conversation_id);
          if (!existing) return prev;
          const out = new Map(prev);
          out.set(msg.conversation_id, { ...existing, members: msg.members });
          return out;
        });
        if (openChatsRef.current.has(msg.conversation_id)) {
          const payload: MembersChangedPayload = { members: msg.members };
          void emitTo(
            `chat-${msg.conversation_id}`,
            EVT.MembersChanged,
            payload,
          );
        }
        return;
      case "error":
        console.error("ws error", msg.code, msg.message);
        return;
      case "pong":
        return;
    }
  }

  function appendMessage(m: OutgoingMessage) {
    const view: MessageView = {
      id: m.id,
      conversation_id: m.conversation_id,
      sender: m.sender,
      body: m.body,
      created_at: m.created_at,
      attachments: m.attachments,
    };
    setMessages((prev) => {
      const existing = prev.get(m.conversation_id) ?? [];
      if (existing.some((x) => x.id === m.id)) return prev;
      const next = [...existing, view].sort((a, b) => a.id - b.id);
      const out = new Map(prev);
      out.set(m.conversation_id, next);
      return out;
    });
    setConversations((prev) => {
      if (prev.has(m.conversation_id)) return prev;
      void refreshConversations();
      return prev;
    });

    // Forward to the chat window if it's open (the chat window plays
    // its own blip + flash, focus-aware).
    if (openChatsRef.current.has(m.conversation_id)) {
      const payload: MessagePayload = { message: view };
      void emitTo(`chat-${m.conversation_id}`, EVT.IncomingMessage, payload);
    }

    // Self-sent messages never bump unread or play sound.
    if (m.sender.id === session.user.id) return;

    const isFocused = focusedConvRef.current === m.conversation_id;
    if (isFocused) return;

    setUnreadByConv((prev) => {
      const out = new Map(prev);
      out.set(m.conversation_id, (out.get(m.conversation_id) ?? 0) + 1);
      return out;
    });
    // Flash + sound only if the chat sub-window isn't already open
    // for this conv — otherwise its own flash/blip handles it.
    if (!openChatsRef.current.has(m.conversation_id)) {
      void flashWindowIfUnfocused();
      playMessageBlip();
    }
  }

  async function ensureHistory(convID: number) {
    if (messagesRef.current.has(convID) || historyLoading.has(convID)) return;
    setHistoryLoading((prev) => new Set(prev).add(convID));
    try {
      const rows = await listMessages(
        session.serverUrl,
        session.token,
        convID,
        0,
        HISTORY_PAGE_SIZE,
      );
      const asc = [...rows].sort((a, b) => a.id - b.id);
      setMessages((prev) => {
        const out = new Map(prev);
        const incoming = prev.get(convID) ?? [];
        out.set(convID, mergeByID(asc, incoming));
        return out;
      });
    } catch (err) {
      console.error("listMessages failed:", err);
    } finally {
      setHistoryLoading((prev) => {
        const out = new Set(prev);
        out.delete(convID);
        return out;
      });
    }
  }

  // ---- chat window spawn / focus / track --------------------------

  async function openChatWindow(convID: number) {
    // Always clear the unread badge optimistically — the conv is about
    // to be visible. If the spawn fails the badge will re-accumulate.
    setUnreadByConv((prev) => {
      if (!prev.has(convID)) return prev;
      const out = new Map(prev);
      out.delete(convID);
      return out;
    });

    const label = `chat-${convID}`;

    // If already open, just focus.
    if (openChatsRef.current.has(convID)) {
      try {
        const all = await getAllWindows();
        const existing = all.find((w) => w.label === label);
        if (existing) {
          await existing.unminimize();
          await existing.setFocus();
          return;
        }
      } catch (err) {
        console.error("focus existing chat failed", err);
      }
    }

    const conv = conversationsRef.current.get(convID);
    const title = conv ? conversationTitle(conv, session.user.id) : "Chat";
    const geom = loadGeometry(convID);

    const win = new WebviewWindow(label, {
      // Per Tauri 2 docs the route is appended to the app URL — works
      // for both `npm run dev` (http://localhost:1420/...) and the
      // packaged tauri://localhost. The hash routes to ChatWindowApp.
      url: `/#/chat/${convID}`,
      title,
      width: geom?.w ?? CHAT_WINDOW_DEFAULT.w,
      height: geom?.h ?? CHAT_WINDOW_DEFAULT.h,
      x: geom?.x,
      y: geom?.y,
      minWidth: CHAT_WINDOW_MIN.w,
      minHeight: CHAT_WINDOW_MIN.h,
      resizable: true,
      visible: true,
      focus: true,
    });

    openChatsRef.current.add(convID);

    // Persist geometry on resize / move (debounced inside the
    // listeners). We deliberately DON'T register an onCloseRequested
    // listener — Tauri's wrapper for that turns the close into a
    // two-step "fire handler then this.destroy()" dance which can
    // require two clicks on some OS configurations. Without a
    // close-requested listener, clicking [X] follows the default
    // path and closes in one click. We listen for the destroyed
    // event afterwards to clean up local state.
    let saveTimer: number | undefined;
    const queueSave = async () => {
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        try {
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          const scale = await win.scaleFactor();
          const next: Geometry = {
            x: Math.round(pos.x / scale),
            y: Math.round(pos.y / scale),
            w: Math.round(size.width / scale),
            h: Math.round(size.height / scale),
          };
          localStorage.setItem(geomKey(convID), JSON.stringify(next));
        } catch {
          /* window may have closed mid-save; ignore */
        }
      }, 200);
    };

    const offResized = await win.onResized(() => void queueSave());
    const offMoved = await win.onMoved(() => void queueSave());
    const offDestroyed = await listen<unknown>(
      TauriEvent.WINDOW_DESTROYED,
      () => {
        offResized();
        offMoved();
        offDestroyed();
        openChatsRef.current.delete(convID);
        if (focusedConvRef.current === convID) {
          focusedConvRef.current = null;
        }
      },
      { target: { kind: "WebviewWindow", label } },
    );
  }

  async function openChatWithUser(user: UserInfo) {
    if (user.id === session.user.id) return;
    for (const c of conversations.values()) {
      if (c.type === "dm" && c.members.some((m) => m.id === user.id)) {
        void openChatWindow(c.id);
        return;
      }
    }
    try {
      const conv = await createDM(session.serverUrl, session.token, user.id);
      setConversations((prev) => new Map(prev).set(conv.id, conv));
      void openChatWindow(conv.id);
    } catch (err) {
      console.error("createDM failed:", err);
    }
  }

  // ---- nudge received ---------------------------------------------

  function triggerNudgeReceived(convID: number, sender: UserInfo) {
    // Ensure the window is open so the user can see the shake.
    const wasOpen = openChatsRef.current.has(convID);
    if (!wasOpen) {
      void openChatWindow(convID).then(() => {
        // Tiny delay so the window's listeners are wired before we
        // fire the nudge event into it.
        window.setTimeout(() => {
          const payload: NudgePayload = { sender };
          void emitTo(`chat-${convID}`, EVT.IncomingNudge, payload);
        }, 300);
      });
    } else {
      const payload: NudgePayload = { sender };
      void emitTo(`chat-${convID}`, EVT.IncomingNudge, payload);
    }
    // Also flash the main window + play in main if the chat window
    // can't render it yet.
    if (!wasOpen) {
      playNudge();
      void flashWindowIfUnfocused();
    }
  }

  // ---- status + sign-out + leave ----------------------------------

  function updateStatus(state: UserState, customText: string) {
    if (state === "offline") return; // server rejects this
    setMyState(state);
    setMyCustomText(customText);
    if (wsRef.current) {
      wsRef.current.send({
        type: "status",
        state,
        custom_text: customText,
      });
    }
  }

  async function handleLeave(conv: ConversationView) {
    try {
      await leaveConversation(session.serverUrl, session.token, conv.id);
      setConversations((prev) => {
        const out = new Map(prev);
        out.delete(conv.id);
        return out;
      });
      setMessages((prev) => {
        const out = new Map(prev);
        out.delete(conv.id);
        return out;
      });
      await closeChatWindow(conv.id);
    } catch (err) {
      console.error("leave failed:", err);
    }
  }

  async function closeChatWindow(convID: number) {
    if (!openChatsRef.current.has(convID)) return;
    try {
      const all = await getAllWindows();
      const w = all.find((x) => x.label === `chat-${convID}`);
      if (w) await w.close();
    } catch (err) {
      console.error("close chat window failed", err);
    }
  }

  async function closeAllChatWindows() {
    const ids = Array.from(openChatsRef.current);
    for (const id of ids) {
      await closeChatWindow(id);
    }
  }

  async function handleSignOut() {
    await closeAllChatWindows();
    wsRef.current?.close();
    try {
      await logout(session.serverUrl, session.token);
    } catch {
      /* best-effort */
    }
    onSignOut();
  }

  // ---- maintenance ------------------------------------------------

  // Expire stale typing indicators in main (we keep them around for
  // potential re-hydrate). Chat windows expire their own copies too.
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        let dirty = false;
        const out = new Map(prev);
        for (const [convID, inner] of prev.entries()) {
          const nextInner = new Map(inner);
          for (const [uid, entry] of inner.entries()) {
            if (entry.expiresAt <= now) {
              nextInner.delete(uid);
              dirty = true;
            }
          }
          if (nextInner.size === 0) {
            out.delete(convID);
          } else {
            out.set(convID, nextInner);
          }
        }
        return dirty ? out : prev;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  // Total unread across every conversation — prefixed onto the OS
  // main-window title MSN-style.
  const totalUnread = useMemo(
    () =>
      Array.from(unreadByConv.values()).reduce((sum, n) => sum + n, 0),
    [unreadByConv],
  );
  useEffect(() => {
    void setWindowTitle(
      totalUnread > 0 ? `(${totalUnread}) OreoHouse` : "OreoHouse",
    );
  }, [totalUnread]);

  return (
    <main className="phase6 chat-screen">
      <header className="topbar">
        <div className="me">
          <strong>{session.user.username}</strong>
          <StatusMenu
            state={myState}
            customText={myCustomText}
            onChange={updateStatus}
          />
          <span className={`ws-status ws-status-${status}`}>{status}</span>
        </div>
        <div className="topbar-right">
          <button
            type="button"
            className="mute-toggle"
            onClick={toggleMuted}
            title={muted ? "Unmute sounds" : "Mute sounds"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <button type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <ContactList
        self={session.user}
        online={online}
        conversations={conversations}
        unreadByConv={unreadByConv}
        onPickUser={openChatWithUser}
        onPickConv={(id) => void openChatWindow(id)}
        onNewGroup={() => setModal("newGroup")}
        onNewRoom={() => setModal("newRoom")}
        onBrowseRooms={() => setModal("browseRooms")}
      />

      {modal === "newGroup" && (
        <Modal title="New group" onClose={() => setModal(null)}>
          <NewGroupForm
            session={session}
            self={session.user}
            online={online.map((p) => p.user)}
            onCreated={(c) => {
              setConversations((prev) => new Map(prev).set(c.id, c));
              setModal(null);
              void openChatWindow(c.id);
            }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === "newRoom" && (
        <Modal title="New room" onClose={() => setModal(null)}>
          <NewRoomForm
            session={session}
            onCreated={(c) => {
              setConversations((prev) => new Map(prev).set(c.id, c));
              setModal(null);
              void openChatWindow(c.id);
            }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === "browseRooms" && (
        <Modal title="Browse rooms" onClose={() => setModal(null)}>
          <BrowseRoomsView
            session={session}
            onJoined={(c) => {
              setConversations((prev) => new Map(prev).set(c.id, c));
              setModal(null);
              void openChatWindow(c.id);
            }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------
// Contact list — primary view
// ---------------------------------------------------------------------

function ContactList({
  self,
  online,
  conversations,
  unreadByConv,
  onPickUser,
  onPickConv,
  onNewGroup,
  onNewRoom,
  onBrowseRooms,
}: {
  self: UserInfo;
  online: PresenceInfo[];
  conversations: Map<number, ConversationView>;
  unreadByConv: Map<number, number>;
  onPickUser: (u: UserInfo) => void;
  onPickConv: (convID: number) => void;
  onNewGroup: () => void;
  onNewRoom: () => void;
  onBrowseRooms: () => void;
}) {
  const onlineIDs = new Set(online.map((p) => p.user.id));

  const dmContactMap = new Map<number, UserInfo>();
  const dmConvByUser = new Map<number, ConversationView>();
  for (const c of conversations.values()) {
    if (c.type !== "dm") continue;
    const other = c.members.find((m) => m.id !== self.id);
    if (!other) continue;
    dmContactMap.set(other.id, other);
    dmConvByUser.set(other.id, c);
  }

  const onlineOthers = sortPresence(
    online.filter((p) => p.user.id !== self.id),
  );
  const offlineContacts = sortByUsername(
    Array.from(dmContactMap.values()).filter((u) => !onlineIDs.has(u.id)),
  );
  const groupsAndRooms = sortConversations(
    Array.from(conversations.values()).filter((c) => c.type !== "dm"),
  );

  function unreadForUser(u: UserInfo): number {
    const conv = dmConvByUser.get(u.id);
    if (!conv) return 0;
    return unreadByConv.get(conv.id) ?? 0;
  }

  return (
    <aside className="contact-list">
      <section>
        <h2>
          Online — <span className="count">{onlineOthers.length}</span>
        </h2>
        {onlineOthers.length === 0 ? (
          <p className="empty">Nobody else is here.</p>
        ) : (
          <ul>
            {onlineOthers.map((p) => (
              <ContactRow
                key={p.user.id}
                user={p.user}
                state={p.state}
                customText={p.custom_text}
                unread={unreadForUser(p.user)}
                onClick={() => onPickUser(p.user)}
              />
            ))}
          </ul>
        )}
      </section>

      {offlineContacts.length > 0 && (
        <section>
          <h2>
            Offline — <span className="count">{offlineContacts.length}</span>
          </h2>
          <ul>
            {offlineContacts.map((u) => (
              <ContactRow
                key={u.id}
                user={u}
                state="offline"
                unread={unreadForUser(u)}
                onClick={() => onPickUser(u)}
              />
            ))}
          </ul>
        </section>
      )}

      {groupsAndRooms.length > 0 && (
        <section>
          <h2>
            Groups & Rooms —{" "}
            <span className="count">{groupsAndRooms.length}</span>
          </h2>
          <ul>
            {groupsAndRooms.map((c) => (
              <ConvRow
                key={c.id}
                conv={c}
                self={self}
                unread={unreadByConv.get(c.id) ?? 0}
                onClick={() => onPickConv(c.id)}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="actions">
        <button type="button" onClick={onNewGroup}>
          + Group
        </button>
        <button type="button" onClick={onNewRoom}>
          + Room
        </button>
        <button type="button" onClick={onBrowseRooms}>
          Browse Rooms
        </button>
      </div>
    </aside>
  );
}

function ContactRow({
  user,
  state,
  customText,
  unread,
  onClick,
}: {
  user: UserInfo;
  state: UserState;
  customText?: string;
  unread: number;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" className="contact-row" onClick={onClick}>
        <span className={`dot dot-${state}`} title={state} />
        <span className="contact-name">{user.username}</span>
        {customText && (
          <span className="contact-status-text" title={customText}>
            {customText}
          </span>
        )}
        {unread > 0 && <span className="unread-badge">{unread}</span>}
      </button>
    </li>
  );
}

function StatusMenu({
  state,
  customText,
  onChange,
}: {
  state: UserState;
  customText: string;
  onChange: (state: UserState, customText: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftText, setDraftText] = useState(customText);

  useEffect(() => setDraftText(customText), [customText]);

  function pickState(s: UserState) {
    onChange(s, draftText);
    setOpen(false);
  }

  function commitText() {
    if (draftText !== customText) onChange(state, draftText);
  }

  return (
    <div className="status-menu">
      <button
        type="button"
        className="status-chip"
        onClick={() => setOpen((v) => !v)}
        title="Set status"
      >
        <span className={`dot dot-${state}`} />
        <span>{stateLabel(state)}</span>
        {customText && <span className="status-text-inline">— {customText}</span>}
      </button>
      {open && (
        <div className="status-popover">
          {(["online", "away", "busy"] as UserState[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`status-option ${s === state ? "selected" : ""}`}
              onClick={() => pickState(s)}
            >
              <span className={`dot dot-${s}`} />
              {stateLabel(s)}
            </button>
          ))}
          <div className="status-text-row">
            <input
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitText();
                  setOpen(false);
                }
              }}
              placeholder="Custom message"
              maxLength={256}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function stateLabel(s: UserState): string {
  switch (s) {
    case "online":
      return "Online";
    case "away":
      return "Away";
    case "busy":
      return "Busy";
    case "offline":
      return "Offline";
  }
}

function ConvRow({
  conv,
  self,
  unread,
  onClick,
}: {
  conv: ConversationView;
  self: UserInfo;
  unread: number;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" className="contact-row" onClick={onClick}>
        <span className="conv-icon">{conversationIcon(conv)}</span>
        <span className="contact-name">{conversationTitle(conv, self.id)}</span>
        <span className="meta">{conv.members.length}</span>
        {unread > 0 && <span className="unread-badge">{unread}</span>}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------
// Modals — for create-group / create-room / browse-rooms
// ---------------------------------------------------------------------

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function NewGroupForm({
  session,
  self,
  online,
  onCreated,
  onCancel,
}: {
  session: Session;
  self: UserInfo;
  online: UserInfo[];
  onCreated: (c: ConversationView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invitable = online.filter((u) => u.id !== self.id);

  function toggle(id: number) {
    setSelected((prev) => {
      const out = new Set(prev);
      if (out.has(id)) out.delete(id);
      else out.add(id);
      return out;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (selected.size === 0) {
      setError("Pick at least one person to invite.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const conv = await createGroup(
        session.serverUrl,
        session.token,
        name.trim(),
        Array.from(selected),
      );
      onCreated(conv);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        Name <span className="hint">(optional)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          placeholder="Family chat"
        />
      </label>
      <fieldset className="member-picker">
        <legend>Invite</legend>
        {invitable.length === 0 ? (
          <p className="empty">
            Nobody else is online right now. Wait for someone to sign in.
          </p>
        ) : (
          <ul>
            {invitable.map((u) => (
              <li key={u.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggle(u.id)}
                  />
                  {u.username}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy || selected.size === 0}>
          {busy ? "Creating…" : "Create group"}
        </button>
      </div>
    </form>
  );
}

function NewRoomForm({
  session,
  onCreated,
  onCancel,
}: {
  session: Session;
  onCreated: (c: ConversationView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const conv = await createRoom(
        session.serverUrl,
        session.token,
        name.trim(),
        topic.trim(),
      );
      onCreated(conv);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          placeholder="general"
          required
        />
      </label>
      <label>
        Topic <span className="hint">(optional)</span>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={256}
          placeholder="What's this room for?"
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create room"}
        </button>
      </div>
    </form>
  );
}

function BrowseRoomsView({
  session,
  onJoined,
  onCancel,
}: {
  session: Session;
  onJoined: (c: ConversationView) => void;
  onCancel: () => void;
}) {
  const [rooms, setRooms] = useState<RoomView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await listRooms(session.serverUrl, session.token);
        setRooms(r);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [session]);

  async function handleJoin(room: RoomView) {
    setJoining(room.id);
    setError(null);
    try {
      const conv = await joinRoom(session.serverUrl, session.token, room.id);
      onJoined(conv);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setJoining(null);
    }
  }

  return (
    <div className="form">
      {error && <div className="error">{error}</div>}
      {rooms === null ? (
        <p className="empty">Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="empty">No rooms yet. Create one with "+ Room".</p>
      ) : (
        <ul className="rooms-list">
          {rooms.map((r) => (
            <li key={r.id}>
              <div className="room-info">
                <div className="room-name">
                  # {r.name} <span className="badge">{r.member_count}</span>
                </div>
                {r.topic && <div className="room-topic">{r.topic}</div>}
              </div>
              <button
                type="button"
                onClick={() => handleJoin(r)}
                disabled={joining === r.id}
              >
                {joining === r.id ? "Joining…" : "Join"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          Close
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function sortByUsername(users: UserInfo[]): UserInfo[] {
  return [...users].sort((a, b) => a.username.localeCompare(b.username));
}

function sortPresence(rows: PresenceInfo[]): PresenceInfo[] {
  return [...rows].sort((a, b) =>
    a.user.username.localeCompare(b.user.username),
  );
}

function sortConversations(convs: ConversationView[]): ConversationView[] {
  return [...convs].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return b.id - a.id;
  });
}

function otherDMMember(
  conv: ConversationView,
  selfID: number,
): UserInfo | null {
  if (conv.type !== "dm") return null;
  return conv.members.find((m) => m.id !== selfID) ?? null;
}

function conversationTitle(conv: ConversationView, selfID: number): string {
  if (conv.type === "dm") {
    const other = otherDMMember(conv, selfID);
    return other ? other.username : `DM #${conv.id}`;
  }
  if (conv.name) return conv.name;
  if (conv.type === "group") return "Unnamed group";
  return `Room #${conv.id}`;
}

function conversationIcon(conv: ConversationView): string {
  if (conv.type === "room") return "#";
  if (conv.type === "group") return "⊙";
  return "•";
}

function mergeByID(a: MessageView[], b: MessageView[]): MessageView[] {
  const byID = new Map<number, MessageView>();
  for (const m of a) byID.set(m.id, m);
  for (const m of b) byID.set(m.id, m);
  return Array.from(byID.values()).sort((x, y) => x.id - y.id);
}

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
  type MessageDeletedPayload,
  type MessageEditedPayload,
  type MessagePayload,
  type NudgePayload,
  type OutgoingDeletePayload,
  type OutgoingEditPayload,
  type OutgoingReactPayload,
  type ReactionPayload,
  type ReadReceiptPayload,
  type SendPayload,
  type SessionSnapshot,
  type TypingPayload,
  type UserUpdatedPayload,
} from "./lib/chatBridge";
import {
  loadMutedConvs,
  saveMutedConvs,
} from "./lib/mutedConvs";
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
  playReactionPop,
  playSignIn,
  playSignOut,
  setMuted as setMutedPersisted,
} from "./lib/sounds";
import {
  flashWindowIfUnfocused,
  setWindowTitle,
} from "./lib/tauri";
import {
  applyTheme,
  loadTheme,
  saveTheme,
  type ThemeName,
} from "./lib/theme";
import { checkForUpdate, type AvailableUpdate } from "./lib/updater";
import { displayNameOf } from "./lib/users";
import { connect, type ConnectionStatus, type WSClient } from "./lib/ws";
import { Avatar } from "./components/Avatar";
import { ProfileModal } from "./components/ProfileModal";
import { SearchModal } from "./components/SearchModal";
import type {
  ConversationView,
  MessageView,
  OutgoingMessage,
  PresenceInfo,
  ReactionGroup,
  RoomView,
  ServerMessage,
  UserInfo,
  UserState,
} from "./types/proto";

import logoUrl from "./assets/logo.png";

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
  // One-shot update check on mount. Null = no update / not in Tauri.
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    void checkForUpdate().then((u) => {
      if (u) setUpdate(u);
    });
  }, []);

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
    return (
      <>
        {update && <UpdateBanner update={update} />}
        <LoginScreen onSession={handleSession} />
      </>
    );
  }
  return (
    <>
      {update && <UpdateBanner update={update} />}
      <ChatScreen session={session} onSignOut={handleClearSession} />
    </>
  );
}

// UpdateBanner: thin strip above the topbar. "Install" downloads the
// signed artifact, verifies it, installs, and relaunches the app.
// While installing we disable the button and show a progress label.
function UpdateBanner({ update }: { update: AvailableUpdate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInstall() {
    setBusy(true);
    setError(null);
    try {
      await update.install();
      // install() relaunches; if we're still here something went odd.
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">
        Update <strong>{update.version}</strong> available
      </span>
      <button
        type="button"
        className="update-banner-install"
        onClick={handleInstall}
        disabled={busy}
      >
        {busy ? "Installing…" : "Install"}
      </button>
      {error && <span className="update-banner-error">{error}</span>}
    </div>
  );
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
      <img className="login-logo" src={logoUrl} alt="Oreo House" />
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
  // Per-conv per-user "highest message id this user has read", populated
  // from welcome.reads and updated by live read_receipt events. The
  // chat-window UI uses these to render ✓ / ✓✓ on own messages.
  const [reads, setReads] = useState<Map<number, Map<number, number>>>(
    new Map(),
  );
  // user_id → UserInfo. Authoritative source for rendering anywhere a
  // user appears (contact rows, message bubbles, etc). Updated from
  // welcome.online, presence deltas, user_profile_changed broadcasts,
  // and the membership lists embedded in ConversationView.
  const [userCache, setUserCache] = useState<Map<number, UserInfo>>(() => {
    const m = new Map<number, UserInfo>();
    m.set(session.user.id, session.user);
    return m;
  });
  // Per-message reactions, populated by message history loads + live
  // reaction events. Chat windows keep their own copy too — this one
  // is the parent cache used for hydrate.
  const [reactions, setReactions] = useState<Map<number, ReactionGroup[]>>(
    new Map(),
  );
  // Per-conv set of pinned message ids. Hydrated lazily via the REST
  // pins endpoint when a chat window opens; kept fresh by the live
  // message_pinned / message_unpinned events.
  const [pinned, setPinned] = useState<Map<number, Set<number>>>(new Map());
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Settings dropdown + the modals it opens.
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Set of conv IDs the user has individually muted (suppresses sound
  // + flash + unread on incoming messages for those convs). Persisted
  // per-machine via localStorage.
  const [mutedConvs, setMutedConvs] = useState<Set<number>>(() => loadMutedConvs());
  const mutedConvsRef = useRef(mutedConvs);
  mutedConvsRef.current = mutedConvs;
  // Active UI theme. Initial value is whatever main.tsx already applied
  // to documentElement on boot, so this ref-backed state stays in sync
  // with the DOM. Changing it re-paints (via applyTheme) AND fans the
  // new value out to every open chat sub-window.
  const [theme, setTheme] = useState<ThemeName>(() => loadTheme());
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // Sign-in / sign-out sounds are gated for the first few seconds
  // after we connect, so the welcome → presence delta burst doesn't
  // turn into a chorus. Armed once the page has been live a moment.
  const presenceSoundsArmedRef = useRef(false);
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
  const readsRef = useRef(reads);
  readsRef.current = reads;
  const userCacheRef = useRef(userCache);
  userCacheRef.current = userCache;
  const reactionsRef = useRef(reactions);
  reactionsRef.current = reactions;

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

  // Theme picker handler. Persists, repaints the main window, and
  // fans the change out to every open chat sub-window so the whole UI
  // flips in one beat.
  function changeTheme(next: ThemeName) {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
    for (const id of openChatsRef.current) {
      void emitTo(`chat-${id}`, EVT.ThemeChanged, { theme: next });
    }
  }

  // upsertUser merges an incoming UserInfo into the cache. If the
  // user_id matches the current session, we ALSO update session.user
  // (and persist) so the topbar reflects display-name/avatar changes
  // the user makes themselves.
  const upsertUser = useCallback(
    (u: UserInfo) => {
      setUserCache((prev) => {
        const next = new Map(prev);
        next.set(u.id, u);
        return next;
      });
      if (u.id === session.user.id) {
        const updated: Session = { ...session, user: u };
        saveSession(updated);
        // We can't call setSession (it's in App) from here without
        // prop-drilling; the cache is enough for visual updates.
        // Topbar reads from userCache for its own avatar.
      }
    },
    [session],
  );

  function applyReaction(
    messageID: number,
    userID: number,
    emoji: string,
    action: "add" | "remove",
  ) {
    setReactions((prev) => {
      const cur = prev.get(messageID) ?? [];
      const next = mergeReaction(cur, userID, emoji, action);
      const out = new Map(prev);
      if (next.length === 0) {
        out.delete(messageID);
      } else {
        out.set(messageID, next);
      }
      return out;
    });
  }

  const refreshConversations = useCallback(async () => {
    try {
      const convs = await listConversations(session.serverUrl, session.token);
      setConversations(new Map(convs.map((c) => [c.id, c])));
      // The REST endpoint now carries display_name + avatar_version on
      // each member; feed the cache so contact rows render correctly
      // before presence catches up.
      for (const c of convs) {
        for (const m of c.members) upsertUser(m);
      }
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
    // Arm presence sounds after 3 s — enough for the initial welcome
    // + presence burst to settle.
    presenceSoundsArmedRef.current = false;
    const armT = window.setTimeout(() => {
      presenceSoundsArmedRef.current = true;
    }, 3000);
    return () => {
      window.clearTimeout(armT);
      presenceSoundsArmedRef.current = false;
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
          // ensureHistory returns the merged message list directly so we
          // don't race against React's commit-then-sync of messagesRef.
          // Reading messagesRef immediately after `await ensureHistory`
          // returned an empty list on first open and forced a
          // close/reopen to repopulate.
          const msgsForConv = await ensureHistory(cid);
          const conv = conversationsRef.current.get(cid);
          if (!conv) return;
          const readsForConv = readsRef.current.get(cid);
          const readsObj: Record<number, number> = {};
          if (readsForConv) {
            for (const [uid, lr] of readsForConv.entries()) {
              readsObj[uid] = lr;
            }
          }
          const reactionsObj: Record<number, ReactionGroup[]> = {};
          for (const m of msgsForConv) {
            const r = reactionsRef.current.get(m.id);
            if (r && r.length > 0) reactionsObj[m.id] = r;
          }
          const hydrate: HydratePayload = {
            session: sessionRef.current,
            conv,
            messages: msgsForConv,
            typers: Array.from(
              (typingRef.current.get(cid) ?? new Map()).values(),
            ),
            muted: mutedRef.current,
            conv_muted: mutedConvsRef.current.has(cid),
            reads: readsObj,
            reactions: reactionsObj,
            pinned: Array.from(pinnedRef.current.get(cid) ?? new Set()),
            theme: themeRef.current,
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
            reply_to_id: e.payload.reply_to_id,
          });
        }),
        await listen<ChatToMainEnvelope<OutgoingEditPayload>>(
          EVT.OutgoingEdit,
          (e) => {
            if (!wsRef.current) return;
            wsRef.current.send({
              type: "edit",
              message_id: e.payload.message_id,
              body: e.payload.body,
            });
          },
        ),
        await listen<ChatToMainEnvelope<OutgoingDeletePayload>>(
          EVT.OutgoingDelete,
          (e) => {
            if (!wsRef.current) return;
            wsRef.current.send({
              type: "delete",
              message_id: e.payload.message_id,
            });
          },
        ),
        await listen<ChatToMainEnvelope<{ message_id: number }>>(
          EVT.OutgoingPin,
          (e) => {
            if (!wsRef.current) return;
            wsRef.current.send({
              type: "pin",
              message_id: e.payload.message_id,
            });
          },
        ),
        await listen<ChatToMainEnvelope<{ message_id: number }>>(
          EVT.OutgoingUnpin,
          (e) => {
            if (!wsRef.current) return;
            wsRef.current.send({
              type: "unpin",
              message_id: e.payload.message_id,
            });
          },
        ),
        await listen<ChatToMainEnvelope<{}>>(EVT.ToggleConvMute, (e) => {
          const cid = e.payload.conversation_id;
          setMutedConvs((prev) => {
            const next = new Set(prev);
            const becomingMuted = !next.has(cid);
            if (becomingMuted) {
              next.add(cid);
            } else {
              next.delete(cid);
            }
            saveMutedConvs(next);
            // Echo the new state back so the chat window can flip
            // its title-bar icon.
            void emitTo(`chat-${cid}`, EVT.ConvMuteChanged, {
              muted: becomingMuted,
            });
            return next;
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
        await listen<ChatToMainEnvelope<OutgoingReactPayload>>(
          EVT.OutgoingReact,
          (e) => {
            if (!wsRef.current) return;
            wsRef.current.send({
              type: "react",
              message_id: e.payload.message_id,
              emoji: e.payload.emoji,
            });
          },
        ),
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
              // Send a "read" cursor for the highest-known message
              // in this conv so the other members' UIs flip from
              // ✓ to ✓✓ on the sender's messages.
              maybeSendRead(cid);
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
        // Seed the user cache with everyone in the snapshot.
        for (const p of msg.online) upsertUser(p.user);
        {
          const me = msg.online.find((p) => p.user.id === session.user.id);
          if (me) {
            setMyState(me.state);
            setMyCustomText(me.custom_text ?? "");
          }
        }
        // Hydrate read-state map. Defensive against an older server
        // that doesn't ship the `reads` field.
        {
          const incoming = msg.reads ?? [];
          const next = new Map<number, Map<number, number>>();
          for (const r of incoming) {
            const inner =
              next.get(r.conversation_id) ?? new Map<number, number>();
            inner.set(r.user_id, r.last_read_message_id);
            next.set(r.conversation_id, inner);
          }
          setReads(next);
        }
        return;
      case "presence":
        upsertUser(msg.user);
        setOnline((prev) => {
          const wasOnline = prev.some((p) => p.user.id === msg.user.id);
          if (msg.state === "offline") {
            // Play sign-out sound only on the offline EDGE — once
            // presence sounds are armed and not for self.
            if (
              wasOnline &&
              presenceSoundsArmedRef.current &&
              msg.user.id !== session.user.id
            ) {
              playSignOut();
            }
            return prev.filter((p) => p.user.id !== msg.user.id);
          }
          // Sign-in sound only on the online EDGE (wasn't in the list).
          if (
            !wasOnline &&
            presenceSoundsArmedRef.current &&
            msg.user.id !== session.user.id
          ) {
            playSignIn();
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
        // Seed userCache from the conv's members so first messages
        // render with the right display_name + avatar.
        for (const m of msg.conversation.members) upsertUser(m);
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
      case "user_profile_changed":
        upsertUser(msg.user);
        // Fan out to every open chat window so member lists +
        // message-sender info refresh live.
        {
          const payload: UserUpdatedPayload = { user: msg.user };
          for (const cid of openChatsRef.current) {
            void emitTo(`chat-${cid}`, EVT.UserUpdated, payload);
          }
        }
        return;
      case "reaction":
        applyReaction(
          msg.message_id,
          msg.user.id,
          msg.emoji,
          msg.action,
        );
        if (openChatsRef.current.has(msg.conversation_id)) {
          const payload: ReactionPayload = {
            message_id: msg.message_id,
            user_id: msg.user.id,
            emoji: msg.emoji,
            action: msg.action,
          };
          void emitTo(
            `chat-${msg.conversation_id}`,
            EVT.IncomingReaction,
            payload,
          );
        }
        // Soft notification when someone reacts (add only) to one of
        // my own messages and the conv isn't the focused window.
        if (msg.action === "add" && msg.user.id !== session.user.id) {
          const target = messagesRef.current
            .get(msg.conversation_id)
            ?.find((m) => m.id === msg.message_id);
          if (target && target.sender.id === session.user.id) {
            const isFocused =
              focusedConvRef.current === msg.conversation_id;
            if (!isFocused) {
              playReactionPop();
              setUnreadByConv((prev) => {
                const out = new Map(prev);
                out.set(
                  msg.conversation_id,
                  (out.get(msg.conversation_id) ?? 0) + 1,
                );
                return out;
              });
              if (!openChatsRef.current.has(msg.conversation_id)) {
                void flashWindowIfUnfocused();
              }
            }
          }
        }
        return;
      case "message_edited": {
        const cid = msg.conversation_id;
        setMessages((prev) => {
          const list = prev.get(cid);
          if (!list) return prev;
          const next = list.map((m) =>
            m.id === msg.message_id
              ? { ...m, body: msg.body, edited_at: msg.edited_at }
              : m,
          );
          const out = new Map(prev);
          out.set(cid, next);
          return out;
        });
        if (openChatsRef.current.has(cid)) {
          const payload: MessageEditedPayload = {
            message_id: msg.message_id,
            body: msg.body,
            edited_at: msg.edited_at,
          };
          void emitTo(`chat-${cid}`, EVT.IncomingMessageEdited, payload);
        }
        return;
      }
      case "message_pinned": {
        const cid = msg.conversation_id;
        setPinned((prev) => {
          const next = new Set<number>(prev.get(cid) ?? []);
          next.add(msg.message_id);
          const out = new Map(prev);
          out.set(cid, next);
          return out;
        });
        if (openChatsRef.current.has(cid)) {
          void emitTo(`chat-${cid}`, EVT.IncomingMessagePinned, {
            message_id: msg.message_id,
          });
        }
        return;
      }
      case "message_unpinned": {
        const cid = msg.conversation_id;
        setPinned((prev) => {
          const cur = prev.get(cid);
          if (!cur) return prev;
          const next = new Set(cur);
          next.delete(msg.message_id);
          const out = new Map(prev);
          if (next.size === 0) out.delete(cid);
          else out.set(cid, next);
          return out;
        });
        if (openChatsRef.current.has(cid)) {
          void emitTo(`chat-${cid}`, EVT.IncomingMessageUnpinned, {
            message_id: msg.message_id,
          });
        }
        return;
      }
      case "message_deleted": {
        const cid = msg.conversation_id;
        setMessages((prev) => {
          const list = prev.get(cid);
          if (!list) return prev;
          const next = list.map((m) =>
            m.id === msg.message_id
              ? { ...m, body: "", deleted_at: msg.deleted_at }
              : m,
          );
          const out = new Map(prev);
          out.set(cid, next);
          return out;
        });
        if (openChatsRef.current.has(cid)) {
          const payload: MessageDeletedPayload = {
            message_id: msg.message_id,
            deleted_at: msg.deleted_at,
          };
          void emitTo(`chat-${cid}`, EVT.IncomingMessageDeleted, payload);
        }
        return;
      }
      case "read_receipt":
        setReads((prev) => {
          const inner = new Map(prev.get(msg.conversation_id) ?? new Map());
          const current = inner.get(msg.user.id) ?? 0;
          if (msg.last_read_message_id <= current) return prev;
          inner.set(msg.user.id, msg.last_read_message_id);
          const out = new Map(prev);
          out.set(msg.conversation_id, inner);
          return out;
        });
        // Forward to the open chat window so its tick marks update
        // without waiting for the React re-render in main.
        if (openChatsRef.current.has(msg.conversation_id)) {
          const payload: ReadReceiptPayload = {
            user_id: msg.user.id,
            last_read_message_id: msg.last_read_message_id,
          };
          void emitTo(
            `chat-${msg.conversation_id}`,
            EVT.IncomingReadReceipt,
            payload,
          );
        }
        return;
      case "conversation_members_changed":
        setConversations((prev) => {
          const existing = prev.get(msg.conversation_id);
          if (!existing) return prev;
          const out = new Map(prev);
          out.set(msg.conversation_id, { ...existing, members: msg.members });
          return out;
        });
        // Each member's UserInfo arrives in the broadcast — fold into
        // the cache so future renders pick up display_name + avatar.
        for (const m of msg.members) upsertUser(m);
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

  // maybeSendRead computes the highest message id main has cached for
  // this conv and emits a "read" cursor over the WS — but only if
  // it's actually moved past our own previously-sent cursor (so we
  // don't churn the server on every focus toggle).
  function maybeSendRead(convID: number) {
    if (!wsRef.current) return;
    const msgs = messagesRef.current.get(convID);
    if (!msgs || msgs.length === 0) return;
    const top = msgs[msgs.length - 1].id;
    const mine = readsRef.current.get(convID)?.get(session.user.id) ?? 0;
    if (top <= mine) return;
    wsRef.current.send({
      type: "read",
      conversation_id: convID,
      last_read_message_id: top,
    });
    // Optimistically update local state so the same focus event
    // doesn't keep re-sending while we wait for the echoed broadcast
    // (which the server only fans out to OTHER members anyway).
    setReads((prev) => {
      const inner = new Map(prev.get(convID) ?? new Map());
      inner.set(session.user.id, top);
      const out = new Map(prev);
      out.set(convID, inner);
      return out;
    });
  }

  function appendMessage(m: OutgoingMessage) {
    upsertUser(m.sender);
    if (m.reactions && m.reactions.length > 0) {
      setReactions((prev) => {
        const out = new Map(prev);
        out.set(m.id, m.reactions!);
        return out;
      });
    }
    const view: MessageView = {
      id: m.id,
      conversation_id: m.conversation_id,
      sender: m.sender,
      body: m.body,
      created_at: m.created_at,
      attachments: m.attachments,
      reactions: m.reactions,
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

    // Conv-muted: silent. No badge bump, no flash, no sound.
    if (mutedConvsRef.current.has(m.conversation_id)) return;

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

  // Returns the merged message list for the conversation so callers
  // that immediately need the data don't have to wait for React to
  // commit + sync messagesRef. This matters for the chat-window
  // hydrate path: main awaits ensureHistory, then needs to send the
  // freshly loaded messages over IPC right away — reading
  // messagesRef.current at that point would still be the *previous*
  // value because setMessages updates the ref via a separate effect.
  async function ensureHistory(convID: number): Promise<MessageView[]> {
    // Already loaded? Return what we have.
    const cached = messagesRef.current.get(convID);
    if (cached) return cached;
    // Someone else is already loading — return whatever's in the ref
    // (probably empty, but it's the best we can do without coordinating
    // with the in-flight call).
    if (historyLoading.has(convID)) return cached ?? [];

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
      // Merge with any live messages that may have arrived via WS
      // while the REST page was in flight. messagesRef holds the most
      // current snapshot.
      const live = messagesRef.current.get(convID) ?? [];
      const merged = mergeByID(asc, live);
      setMessages((prev) => {
        const out = new Map(prev);
        out.set(convID, merged);
        return out;
      });
      // Hydrate the per-message reactions cache from the page.
      // Also stuff each message's sender into the user cache (the
      // server populates display_name + has_avatar on these views).
      setReactions((prev) => {
        const out = new Map(prev);
        for (const m of asc) {
          if (m.reactions && m.reactions.length > 0) {
            out.set(m.id, m.reactions);
          }
        }
        return out;
      });
      for (const m of asc) upsertUser(m.sender);
      return merged;
    } catch (err) {
      console.error("listMessages failed:", err);
      return messagesRef.current.get(convID) ?? [];
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
      // Default in Tauri 2 is to let the OS capture drops and fire
      // tauri://drag-drop on the Rust side. We want the standard
      // HTML5 ondrop event in the webview so our composer drag-drop
      // upload code sees the files.
      dragDropEnabled: false,
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
          <button
            type="button"
            className="me-avatar"
            onClick={() => setProfileOpen(true)}
            title="Edit profile"
          >
            <Avatar
              user={userCache.get(session.user.id) ?? session.user}
              serverUrl={session.serverUrl}
              token={session.token}
              size={32}
            />
          </button>
          <strong>{displayNameOf(userCache.get(session.user.id) ?? session.user)}</strong>
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
            onClick={() => setSearchOpen(true)}
            title="Search messages"
          >
            🔍
          </button>
          <button
            type="button"
            className="mute-toggle"
            onClick={toggleMuted}
            title={muted ? "Unmute sounds" : "Mute sounds"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <div className="settings-anchor">
            <button
              type="button"
              className="mute-toggle"
              onClick={() => setMenuOpen((v) => !v)}
              title="Menu"
            >
              ⚙️
            </button>
            {menuOpen && (
              <SettingsMenu
                onClose={() => setMenuOpen(false)}
                onAbout={() => { setMenuOpen(false); setAboutOpen(true); }}
                onShortcuts={() => { setMenuOpen(false); setShortcutsOpen(true); }}
                onCheckUpdate={async () => {
                  setMenuOpen(false);
                  const u = await checkForUpdate();
                  if (u) {
                    if (confirm(`Update available: ${u.version}. Install now?`)) {
                      try { await u.install(); } catch (e) { alert("Update failed: " + (e as Error).message); }
                    }
                  } else {
                    alert("You're on the latest version.");
                  }
                }}
                onSignOut={() => { setMenuOpen(false); handleSignOut(); }}
              />
            )}
          </div>
        </div>
      </header>

      {profileOpen && (
        <ProfileModal
          me={userCache.get(session.user.id) ?? session.user}
          serverUrl={session.serverUrl}
          token={session.token}
          theme={theme}
          onThemeChange={changeTheme}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {searchOpen && (
        <SearchModal
          serverUrl={session.serverUrl}
          token={session.token}
          conversations={conversations}
          userCache={userCache}
          self={session.user}
          onJump={(cid) => void openChatWindow(cid)}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

      <ContactList
        self={session.user}
        online={online}
        conversations={conversations}
        unreadByConv={unreadByConv}
        userCache={userCache}
        serverUrl={session.serverUrl}
        token={session.token}
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
  userCache,
  serverUrl,
  token,
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
  userCache: Map<number, UserInfo>;
  serverUrl: string;
  token: string;
  onPickUser: (u: UserInfo) => void;
  onPickConv: (convID: number) => void;
  onNewGroup: () => void;
  onNewRoom: () => void;
  onBrowseRooms: () => void;
}) {
  // Resolve a user against the cache so newly-uploaded avatars and
  // display-name edits show without waiting for the next presence
  // tick.
  function enrich(u: UserInfo): UserInfo {
    return userCache.get(u.id) ?? u;
  }
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
                user={enrich(p.user)}
                state={p.state}
                customText={p.custom_text}
                unread={unreadForUser(p.user)}
                serverUrl={serverUrl}
                token={token}
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
                user={enrich(u)}
                state="offline"
                unread={unreadForUser(u)}
                serverUrl={serverUrl}
                token={token}
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
  serverUrl,
  token,
  onClick,
}: {
  user: UserInfo;
  state: UserState;
  customText?: string;
  unread: number;
  serverUrl: string;
  token: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" className="contact-row" onClick={onClick}>
        <span className="contact-avatar-wrap">
          <Avatar user={user} serverUrl={serverUrl} token={token} size={28} />
          <span className={`dot dot-${state} dot-overlay`} title={state} />
        </span>
        <span className="contact-name">{displayNameOf(user)}</span>
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

// mergeReaction applies a single (user_id, emoji, add/remove) delta to
// a message's reaction groups. Returns a NEW array (or [] when the
// last reaction is removed) — callers swap it into their map.
function mergeReaction(
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

function mergeByID(a: MessageView[], b: MessageView[]): MessageView[] {
  const byID = new Map<number, MessageView>();
  for (const m of a) byID.set(m.id, m);
  for (const m of b) byID.set(m.id, m);
  return Array.from(byID.values()).sort((x, y) => x.id - y.id);
}

// ----------------------------------------------------------------------
// Settings menu (⚙️ dropdown) + About / Keyboard-shortcuts modals.
// Tiny presentational components kept inline because they only exist
// to ship a few rows of JSX each.
// ----------------------------------------------------------------------

const REPO_URL = "https://github.com/BiffstaGaming/OreoHouse";
const APP_VERSION = "0.16.1"; // synced manually with client/package.json

function SettingsMenu({
  onClose,
  onAbout,
  onShortcuts,
  onCheckUpdate,
  onSignOut,
}: {
  onClose: () => void;
  onAbout: () => void;
  onShortcuts: () => void;
  onCheckUpdate: () => void;
  onSignOut: () => void;
}) {
  useEffect(() => {
    function close(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".settings-menu") && !t.closest(".settings-anchor")) {
        onClose();
      }
    }
    function esc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("click", close, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", close, true);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div className="settings-menu">
      <button type="button" className="settings-menu-item" onClick={onAbout}>
        ℹ️ About OreoHouse
      </button>
      <button type="button" className="settings-menu-item" onClick={onShortcuts}>
        ⌨️ Keyboard shortcuts
      </button>
      <button type="button" className="settings-menu-item" onClick={onCheckUpdate}>
        🔄 Check for updates
      </button>
      <a
        className="settings-menu-item"
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClose}
      >
        🐙 View on GitHub
      </a>
      <div className="settings-menu-sep" />
      <button
        type="button"
        className="settings-menu-item settings-menu-danger"
        onClick={onSignOut}
      >
        🚪 Sign out
      </button>
    </div>
  );
}

function AboutModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function esc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal about-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>About OreoHouse</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body about-body">
          <img className="about-logo" src={logoUrl} alt="Oreo House" />
          <p className="about-version">Desktop client — version {APP_VERSION}</p>
          <p className="about-blurb">
            Self-hosted family LAN messenger. MSN-Messenger flavour, modern guts,
            zero cloud dependencies.
          </p>
          <div className="about-links">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer">Release notes</a>
            <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">Report a bug</a>
          </div>
          <div className="form-actions">
            <button type="button" className="primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function esc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const isMac = /Mac|iPad|iPhone/i.test(navigator.platform);
  const cmd = isMac ? "⌘" : "Ctrl";
  const rows: [string, string][] = [
    [`${cmd} + K`,    "Open search"],
    ["Enter",         "Send message"],
    ["Shift + Enter", "Insert newline in composer"],
    ["Esc",           "Cancel reply / edit / close modal"],
    ["Click avatar",  "Open profile + theme picker"],
    ["Click 📌",       "View pinned messages"],
    ["Click 🖼️",       "View media + links"],
    ["Click 🔔 / 🔕",  "Toggle conversation mute"],
    ["Click 🔊 / 🔇",  "Toggle all sounds"],
  ];
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal shortcuts-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">
          <table className="shortcuts-table">
            <tbody>
              {rows.map(([k, d]) => (
                <tr key={k}>
                  <td className="shortcut-key"><kbd>{k}</kbd></td>
                  <td className="shortcut-desc">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <button type="button" className="primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

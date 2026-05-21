import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  createDM,
  createGroup,
  createRoom,
  fileURL,
  httpToWs,
  joinRoom,
  leaveConversation,
  listConversations,
  listMessages,
  listRooms,
  login,
  logout,
  uploadFile,
} from "./lib/api";
import {
  flashWindowIfUnfocused,
  setWindowTitle,
} from "./lib/tauri";
import { connect, type ConnectionStatus, type WSClient } from "./lib/ws";
import type {
  AttachmentView,
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

type Session = {
  serverUrl: string;
  token: string;
  user: UserInfo;
};

type ChatWindowState = {
  position: { x: number; y: number };
  minimized: boolean;
  zIndex: number;
};

type PendingAttachment =
  | { kind: "uploading"; localID: string; filename: string }
  | { kind: "ready"; localID: string; view: AttachmentView }
  | { kind: "error"; localID: string; filename: string; error: string };

type ModalKind = "newGroup" | "newRoom" | "browseRooms";

const DEFAULT_SERVER_URL = "http://localhost:8080";
const HISTORY_PAGE_SIZE = 50;
const WINDOW_SPAWN_BASE = { x: 90, y: 70 };
const WINDOW_DEFAULT_SIZE = { w: 380, h: 460 };
const WINDOW_MIN_VISIBLE = 80; // keep at least this many px on-screen when dragging
const TYPING_SEND_THROTTLE_MS = 2000; // outgoing typing events
const TYPING_EXPIRY_MS = 5000; // how long an incoming typing indicator sticks
const NUDGE_COOLDOWN_MS = 3000; // sender-side button cooldown
const SHAKE_DURATION_MS = 700; // matches the CSS @keyframes shake length

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  if (!session) {
    return <LoginScreen onSession={setSession} />;
  }
  return <ChatScreen session={session} onSignOut={() => setSession(null)} />;
}

// ---------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------

function LoginScreen({ onSession }: { onSession: (s: Session) => void }) {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
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
  const [openWindows, setOpenWindows] = useState<Map<number, ChatWindowState>>(
    new Map(),
  );
  const [topZ, setTopZ] = useState(10);
  const [unreadByConv, setUnreadByConv] = useState<Map<number, number>>(
    new Map(),
  );
  // Per-conversation typing indicators. Inner map: user_id →
  // {username, expiresAt}. Entries expire after TYPING_EXPIRY_MS via
  // the interval below.
  const [typing, setTyping] = useState<
    Map<number, Map<number, { username: string; expiresAt: number }>>
  >(new Map());
  // Set of conversation IDs whose chat window should be shaking right
  // now. Entries auto-clear after SHAKE_DURATION_MS.
  const [shaking, setShaking] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [historyLoading, setHistoryLoading] = useState<Set<number>>(new Set());
  const wsRef = useRef<WSClient | null>(null);

  // Refs mirroring the latest state so handleServerMessage (set once in
  // the connect call) can see the current open-windows map.
  const openWindowsRef = useRef(openWindows);
  openWindowsRef.current = openWindows;

  const refreshConversations = useCallback(async () => {
    try {
      const convs = await listConversations(session.serverUrl, session.token);
      setConversations(new Map(convs.map((c) => [c.id, c])));
    } catch (err) {
      console.error("listConversations failed:", err);
    }
  }, [session]);

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

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome":
        setOnline(sortPresence(msg.online));
        // Initialise our own status panel from the snapshot.
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
        // If it's about me (e.g. from another tab), mirror it locally.
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
        return;
      case "typing":
        // Don't show our own echoes (server already filters but be
        // defensive against future protocol changes).
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
        return;
      case "nudge":
        triggerNudgeReceived(msg.conversation_id);
        return;
      case "conversation_members_changed":
        setConversations((prev) => {
          const existing = prev.get(msg.conversation_id);
          if (!existing) return prev;
          const out = new Map(prev);
          out.set(msg.conversation_id, { ...existing, members: msg.members });
          return out;
        });
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

    // Unread + OS attention: only if the message isn't mine AND the
    // user isn't actively looking at the conv (its window open,
    // un-minimized, and on top).
    if (m.sender.id === session.user.id) return;
    const w = openWindowsRef.current.get(m.conversation_id);
    const focusedConv = w && !w.minimized && w.zIndex === topZ;
    if (focusedConv) return;
    setUnreadByConv((prev) => {
      const out = new Map(prev);
      out.set(m.conversation_id, (out.get(m.conversation_id) ?? 0) + 1);
      return out;
    });
    // Flash the taskbar / dock when the main window is unfocused so
    // the user notices even with the app in the background.
    void flashWindowIfUnfocused();
  }

  async function ensureHistory(convID: number) {
    if (messages.has(convID) || historyLoading.has(convID)) return;
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

  function openConvWindow(convID: number) {
    setOpenWindows((prev) => {
      const existing = prev.get(convID);
      const newZ = topZ + 1;
      const out = new Map(prev);
      if (existing) {
        out.set(convID, { ...existing, minimized: false, zIndex: newZ });
      } else {
        const offset = (prev.size % 6) * 28;
        out.set(convID, {
          position: {
            x: WINDOW_SPAWN_BASE.x + offset,
            y: WINDOW_SPAWN_BASE.y + offset,
          },
          minimized: false,
          zIndex: newZ,
        });
      }
      return out;
    });
    setTopZ((z) => z + 1);
    setUnreadByConv((prev) => {
      if (!prev.has(convID)) return prev;
      const out = new Map(prev);
      out.delete(convID);
      return out;
    });
    void ensureHistory(convID);
  }

  function closeConvWindow(convID: number) {
    setOpenWindows((prev) => {
      const out = new Map(prev);
      out.delete(convID);
      return out;
    });
  }

  function minimizeConvWindow(convID: number) {
    setOpenWindows((prev) => {
      const w = prev.get(convID);
      if (!w) return prev;
      const out = new Map(prev);
      out.set(convID, { ...w, minimized: true });
      return out;
    });
  }

  function setConvWindowPos(convID: number, pos: { x: number; y: number }) {
    setOpenWindows((prev) => {
      const w = prev.get(convID);
      if (!w) return prev;
      const out = new Map(prev);
      out.set(convID, { ...w, position: pos });
      return out;
    });
  }

  function bringToFront(convID: number) {
    setOpenWindows((prev) => {
      const w = prev.get(convID);
      if (!w) return prev;
      if (w.zIndex === topZ) return prev;
      const out = new Map(prev);
      out.set(convID, { ...w, zIndex: topZ + 1 });
      return out;
    });
    setTopZ((z) => z + 1);
    setUnreadByConv((prev) => {
      if (!prev.has(convID)) return prev;
      const out = new Map(prev);
      out.delete(convID);
      return out;
    });
  }

  async function openChatWithUser(user: UserInfo) {
    if (user.id === session.user.id) return;
    for (const c of conversations.values()) {
      if (c.type === "dm" && c.members.some((m) => m.id === user.id)) {
        openConvWindow(c.id);
        return;
      }
    }
    try {
      const conv = await createDM(session.serverUrl, session.token, user.id);
      setConversations((prev) => new Map(prev).set(conv.id, conv));
      openConvWindow(conv.id);
    } catch (err) {
      console.error("createDM failed:", err);
    }
  }

  function sendMessage(
    convID: number,
    body: string,
    attachmentIDs?: number[],
  ) {
    if (!wsRef.current) return;
    wsRef.current.send({
      type: "message",
      conversation_id: convID,
      body,
      attachment_ids: attachmentIDs,
    });
  }

  function sendTyping(convID: number) {
    if (!wsRef.current) return;
    wsRef.current.send({
      type: "typing",
      conversation_id: convID,
    });
  }

  function sendNudge(convID: number) {
    if (!wsRef.current) return;
    wsRef.current.send({
      type: "nudge",
      conversation_id: convID,
    });
  }

  // triggerNudgeReceived shakes the conversation's chat window for
  // SHAKE_DURATION_MS, opening or restoring the window first if it
  // isn't already visible.
  function triggerNudgeReceived(convID: number) {
    // Open the window if it's closed or minimized so the user can
    // actually see the shake.
    const w = openWindowsRef.current.get(convID);
    if (!w || w.minimized) {
      openConvWindow(convID);
    }
    setShaking((prev) => {
      const out = new Set(prev);
      out.add(convID);
      return out;
    });
    setTimeout(() => {
      setShaking((prev) => {
        if (!prev.has(convID)) return prev;
        const out = new Set(prev);
        out.delete(convID);
        return out;
      });
    }, SHAKE_DURATION_MS);
  }

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
      closeConvWindow(conv.id);
    } catch (err) {
      console.error("leave failed:", err);
    }
  }

  async function handleSignOut() {
    wsRef.current?.close();
    await logout(session.serverUrl, session.token);
    onSignOut();
  }

  // Expire stale typing indicators once a second. Done as a single
  // global tick rather than per-conversation timers so we don't fan
  // out timers on every keystroke.
  useEffect(() => {
    const t = setInterval(() => {
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
    return () => clearInterval(t);
  }, []);

  // Total unread across every conversation — prefixed onto the OS
  // window title MSN-style so the count shows in the taskbar.
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

  const openWindowEntries = useMemo(
    () =>
      Array.from(openWindows.entries()).filter(
        ([id, w]) => !w.minimized && conversations.has(id),
      ),
    [openWindows, conversations],
  );
  const minimizedEntries = useMemo(
    () =>
      Array.from(openWindows.entries()).filter(
        ([id, w]) => w.minimized && conversations.has(id),
      ),
    [openWindows, conversations],
  );

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
        <button type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <ContactList
        self={session.user}
        online={online}
        conversations={conversations}
        unreadByConv={unreadByConv}
        onPickUser={openChatWithUser}
        onPickConv={openConvWindow}
        onNewGroup={() => setModal("newGroup")}
        onNewRoom={() => setModal("newRoom")}
        onBrowseRooms={() => setModal("browseRooms")}
      />

      <div className="windows-layer">
        {openWindowEntries.map(([convID, state]) => {
          const conv = conversations.get(convID)!;
          const typers = Array.from(
            (typing.get(convID) ?? new Map()).values(),
          ) as { username: string; expiresAt: number }[];
          return (
            <ChatWindow
              key={convID}
              session={session}
              conv={conv}
              state={state}
              messages={messages.get(convID) ?? []}
              typers={typers}
              shaking={shaking.has(convID)}
              onMove={(p) => setConvWindowPos(convID, p)}
              onClose={() => closeConvWindow(convID)}
              onMinimize={() => minimizeConvWindow(convID)}
              onFocus={() => bringToFront(convID)}
              onSend={(body, atts) => sendMessage(convID, body, atts)}
              onTyping={() => sendTyping(convID)}
              onNudge={() => sendNudge(convID)}
              onLeave={() => handleLeave(conv)}
            />
          );
        })}
      </div>

      {minimizedEntries.length > 0 && (
        <div className="minimized-bar">
          {minimizedEntries.map(([convID]) => {
            const conv = conversations.get(convID)!;
            return (
              <MinimizedChip
                key={convID}
                conv={conv}
                self={session.user}
                unread={unreadByConv.get(convID) ?? 0}
                onRestore={() => openConvWindow(convID)}
                onClose={() => closeConvWindow(convID)}
              />
            );
          })}
        </div>
      )}

      {modal === "newGroup" && (
        <Modal title="New group" onClose={() => setModal(null)}>
          <NewGroupForm
            session={session}
            self={session.user}
            online={online.map((p) => p.user)}
            onCreated={(c) => {
              setConversations((prev) => new Map(prev).set(c.id, c));
              setModal(null);
              openConvWindow(c.id);
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
              openConvWindow(c.id);
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
              openConvWindow(c.id);
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

  // Map every DM partner -> their UserInfo (lifted from conversation
  // membership), and the corresponding conversation id so we can route
  // unread badges correctly.
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

// StatusMenu — the topbar dropdown for setting your own state +
// custom message. Click the chip to open; pick a state or edit the
// text (Enter / blur to save).
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
// Chat window — floating, draggable, minimizable
// ---------------------------------------------------------------------

function ChatWindow({
  session,
  conv,
  state,
  messages,
  typers,
  shaking,
  onMove,
  onClose,
  onMinimize,
  onFocus,
  onSend,
  onTyping,
  onNudge,
  onLeave,
}: {
  session: Session;
  conv: ConversationView;
  state: ChatWindowState;
  messages: MessageView[];
  typers: { username: string; expiresAt: number }[];
  shaking: boolean;
  onMove: (pos: { x: number; y: number }) => void;
  onClose: () => void;
  onMinimize: () => void;
  onFocus: () => void;
  onSend: (body: string, attachmentIDs?: number[]) => void;
  onTyping: () => void;
  onNudge: () => void;
  onLeave: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [nudgeCooldown, setNudgeCooldown] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTypingSentAt = useRef(0);

  function handleNudgeClick() {
    if (nudgeCooldown) return;
    onNudge();
    setNudgeCooldown(true);
    setTimeout(() => setNudgeCooldown(false), NUDGE_COOLDOWN_MS);
  }

  // Scroll to bottom whenever new messages arrive in this window.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Drag — attach document-level listeners only while dragging.
  useEffect(() => {
    if (!isDragging) return;
    function onMouseMove(e: MouseEvent) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const maxX = window.innerWidth - WINDOW_MIN_VISIBLE;
      const maxY = window.innerHeight - WINDOW_MIN_VISIBLE;
      const nextX = clamp(dragRef.current.startPosX + dx, 0, maxX);
      const nextY = clamp(dragRef.current.startPosY + dy, 0, maxY);
      onMove({ x: nextX, y: nextY });
    }
    function onMouseUp() {
      setIsDragging(false);
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, onMove]);

  function startDrag(e: ReactMouseEvent) {
    // Only react to left-button drags on the bare header (not on
    // buttons inside it).
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: state.position.x,
      startPosY: state.position.y,
    };
    setIsDragging(true);
    onFocus();
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
    onSend(body, readyIDs.length > 0 ? readyIDs : undefined);
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
    <section
      className={`chat-window ${shaking ? "shaking" : ""}`}
      style={{
        left: state.position.x,
        top: state.position.y,
        width: WINDOW_DEFAULT_SIZE.w,
        height: WINDOW_DEFAULT_SIZE.h,
        zIndex: state.zIndex,
      }}
      onMouseDown={onFocus}
    >
      <header
        className={`chat-window-header ${isDragging ? "dragging" : ""}`}
        onMouseDown={startDrag}
      >
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
                if (confirm(`Leave ${title}?`)) onLeave();
              }}
            >
              Leave
            </button>
          )}
          <button
            type="button"
            className="chat-window-button"
            title="Minimize"
            onClick={onMinimize}
          >
            _
          </button>
          <button
            type="button"
            className="chat-window-button"
            title="Close"
            onClick={onClose}
          >
            ×
          </button>
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
                onTyping();
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
    </section>
  );
}

function MinimizedChip({
  conv,
  self,
  unread,
  onRestore,
  onClose,
}: {
  conv: ConversationView;
  self: UserInfo;
  unread: number;
  onRestore: () => void;
  onClose: () => void;
}) {
  const title = conversationTitle(conv, self.id);
  return (
    <div className="min-chip">
      <button
        type="button"
        className="min-chip-restore"
        onClick={onRestore}
        title={`Restore ${title}`}
      >
        <span className="conv-icon">{conversationIcon(conv)}</span>
        <span className="min-chip-title">{title}</span>
        {unread > 0 && <span className="unread-badge">{unread}</span>}
      </button>
      <button
        type="button"
        className="min-chip-close"
        onClick={onClose}
        title="Close"
      >
        ×
      </button>
    </div>
  );
}

function MessageRow({
  m,
  session,
}: {
  m: MessageView;
  session: Session;
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
  session: Session;
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
    <a
      className="msg-file"
      href={url}
      download={a.filename}
      title={a.filename}
    >
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
  // Close on Escape.
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

function conversationIcon(conv: ConversationView): string {
  if (conv.type === "room") return "#";
  if (conv.type === "group") return "⊙";
  return "•";
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

function mergeByID(a: MessageView[], b: MessageView[]): MessageView[] {
  const byID = new Map<number, MessageView>();
  for (const m of a) byID.set(m.id, m);
  for (const m of b) byID.set(m.id, m);
  return Array.from(byID.values()).sort((x, y) => x.id - y.id);
}

function cryptoRandomID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function formatTypers(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more are`;
}

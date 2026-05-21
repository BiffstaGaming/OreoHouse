import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
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
import { connect, type ConnectionStatus, type WSClient } from "./lib/ws";
import type {
  ConversationView,
  MessageView,
  OutgoingMessage,
  RoomView,
  ServerMessage,
  UserInfo,
} from "./types/proto";

import "./App.css";

type Session = {
  serverUrl: string;
  token: string;
  user: UserInfo;
};

type View =
  | { kind: "empty" }
  | { kind: "chat"; conversationID: number }
  | { kind: "newGroup" }
  | { kind: "newRoom" }
  | { kind: "browseRooms" };

const DEFAULT_SERVER_URL = "http://localhost:8080";
const HISTORY_PAGE_SIZE = 50;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  if (!session) {
    return <LoginScreen onSession={setSession} />;
  }
  return <ChatScreen session={session} onSignOut={() => setSession(null)} />;
}

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
    <main className="phase4 login-screen">
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

function ChatScreen({
  session,
  onSignOut,
}: {
  session: Session;
  onSignOut: () => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [online, setOnline] = useState<UserInfo[]>([]);
  const [conversations, setConversations] = useState<
    Map<number, ConversationView>
  >(new Map());
  const [messages, setMessages] = useState<Map<number, MessageView[]>>(
    new Map(),
  );
  const [view, setView] = useState<View>({ kind: "empty" });
  const [historyLoading, setHistoryLoading] = useState<Set<number>>(new Set());
  const wsRef = useRef<WSClient | null>(null);

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
        setOnline(sortByUsername(msg.online));
        return;
      case "presence":
        setOnline((prev) => {
          if (msg.status === "online") {
            if (prev.some((u) => u.id === msg.user.id)) return prev;
            return sortByUsername([...prev, msg.user]);
          }
          return prev.filter((u) => u.id !== msg.user.id);
        });
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
      case "conversation_members_changed":
        setConversations((prev) => {
          const existing = prev.get(msg.conversation_id);
          if (!existing) return prev; // fire-and-forget; we don't have the conv yet
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

  function openConversation(id: number) {
    setView({ kind: "chat", conversationID: id });
    void ensureHistory(id);
  }

  async function openDMWith(user: UserInfo) {
    if (user.id === session.user.id) return;
    try {
      const conv = await createDM(session.serverUrl, session.token, user.id);
      setConversations((prev) => new Map(prev).set(conv.id, conv));
      openConversation(conv.id);
    } catch (err) {
      console.error("createDM failed:", err);
    }
  }

  function sendMessage(body: string) {
    if (view.kind !== "chat" || !wsRef.current) return;
    wsRef.current.send({
      type: "message",
      conversation_id: view.conversationID,
      body,
    });
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
      setView({ kind: "empty" });
    } catch (err) {
      console.error("leave failed:", err);
    }
  }

  async function handleSignOut() {
    wsRef.current?.close();
    await logout(session.serverUrl, session.token);
    onSignOut();
  }

  const selectedConv =
    view.kind === "chat" ? conversations.get(view.conversationID) ?? null : null;
  const selectedMessages = useMemo(
    () =>
      view.kind === "chat" ? messages.get(view.conversationID) ?? [] : [],
    [view, messages],
  );
  const sortedConvs = useMemo(
    () => sortConversations(Array.from(conversations.values())),
    [conversations],
  );

  return (
    <main className="phase4 chat-screen">
      <header className="topbar">
        <div className="me">
          <strong>{session.user.username}</strong>
          <span className={`ws-status ws-status-${status}`}>{status}</span>
        </div>
        <button type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <div className="panes">
        <LeftPane
          self={session.user}
          conversations={sortedConvs}
          online={online}
          view={view}
          onNewGroup={() => setView({ kind: "newGroup" })}
          onNewRoom={() => setView({ kind: "newRoom" })}
          onBrowseRooms={() => setView({ kind: "browseRooms" })}
          onPickConv={openConversation}
          onPickUser={openDMWith}
        />
        <RightPane
          session={session}
          view={view}
          conversation={selectedConv}
          messages={selectedMessages}
          online={online}
          onSend={sendMessage}
          onLeave={handleLeave}
          onCancelForm={() => setView({ kind: "empty" })}
          onGroupCreated={(c) => {
            setConversations((prev) => new Map(prev).set(c.id, c));
            openConversation(c.id);
          }}
          onRoomCreated={(c) => {
            setConversations((prev) => new Map(prev).set(c.id, c));
            openConversation(c.id);
          }}
          onRoomJoined={(c) => {
            setConversations((prev) => new Map(prev).set(c.id, c));
            openConversation(c.id);
          }}
        />
      </div>
    </main>
  );
}

// --- Left pane --------------------------------------------------------

function LeftPane({
  self,
  conversations,
  online,
  view,
  onNewGroup,
  onNewRoom,
  onBrowseRooms,
  onPickConv,
  onPickUser,
}: {
  self: UserInfo;
  conversations: ConversationView[];
  online: UserInfo[];
  view: View;
  onNewGroup: () => void;
  onNewRoom: () => void;
  onBrowseRooms: () => void;
  onPickConv: (id: number) => void;
  onPickUser: (u: UserInfo) => void;
}) {
  const selectedConvID = view.kind === "chat" ? view.conversationID : null;

  return (
    <aside className="pane left-pane">
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

      <h2>Conversations</h2>
      {conversations.length === 0 ? (
        <p className="empty">No conversations yet.</p>
      ) : (
        <ul className="conv-list">
          {conversations.map((c) => {
            const isSelected = c.id === selectedConvID;
            return (
              <li key={c.id} className={isSelected ? "selected" : ""}>
                <button
                  type="button"
                  className="conv-row"
                  onClick={() => onPickConv(c.id)}
                >
                  <span className="conv-icon">{conversationIcon(c)}</span>
                  <span className="conv-title">
                    {conversationTitle(c, self.id)}
                  </span>
                  {c.type !== "dm" && (
                    <span className="badge">{c.members.length}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="online-heading">
        Online — <span className="count">{online.length}</span>
      </h2>
      {online.length === 0 ? (
        <p className="empty">Nobody else is here.</p>
      ) : (
        <ul className="presence-list">
          {online.map((u) => {
            const isSelf = u.id === self.id;
            return (
              <li key={u.id} className={isSelf ? "self" : ""}>
                <button
                  type="button"
                  className="presence-row"
                  onClick={() => onPickUser(u)}
                  disabled={isSelf}
                  title={isSelf ? "you" : `open DM with ${u.username}`}
                >
                  <span className="dot" />
                  <span className="username">{u.username}</span>
                  {isSelf && <span className="badge">you</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

// --- Right pane (dispatcher) ------------------------------------------

function RightPane(props: {
  session: Session;
  view: View;
  conversation: ConversationView | null;
  messages: MessageView[];
  online: UserInfo[];
  onSend: (body: string) => void;
  onLeave: (c: ConversationView) => void;
  onCancelForm: () => void;
  onGroupCreated: (c: ConversationView) => void;
  onRoomCreated: (c: ConversationView) => void;
  onRoomJoined: (c: ConversationView) => void;
}) {
  switch (props.view.kind) {
    case "chat":
      return (
        <ChatView
          self={props.session.user}
          conv={props.conversation}
          messages={props.messages}
          onSend={props.onSend}
          onLeave={props.onLeave}
        />
      );
    case "newGroup":
      return (
        <NewGroupForm
          session={props.session}
          self={props.session.user}
          online={props.online}
          onCreated={props.onGroupCreated}
          onCancel={props.onCancelForm}
        />
      );
    case "newRoom":
      return (
        <NewRoomForm
          session={props.session}
          onCreated={props.onRoomCreated}
          onCancel={props.onCancelForm}
        />
      );
    case "browseRooms":
      return (
        <BrowseRoomsView
          session={props.session}
          onJoined={props.onRoomJoined}
          onCancel={props.onCancelForm}
        />
      );
    case "empty":
      return (
        <section className="pane chat-pane chat-pane-empty">
          <p>Pick a conversation on the left, or start a new one.</p>
        </section>
      );
  }
}

// --- Chat view --------------------------------------------------------

function ChatView({
  self,
  conv,
  messages,
  onSend,
  onLeave,
}: {
  self: UserInfo;
  conv: ConversationView | null;
  messages: MessageView[];
  onSend: (body: string) => void;
  onLeave: (c: ConversationView) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, conv?.id]);

  if (!conv) {
    return (
      <section className="pane chat-pane chat-pane-empty">
        <p>Conversation not found.</p>
      </section>
    );
  }

  const title = conversationTitle(conv, self.id);
  const subtitle = conversationSubtitle(conv, self.id);

  function trySend() {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  }

  return (
    <section className="pane chat-pane">
      <header className="chat-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chat-subtitle">{subtitle}</p>}
        </div>
        {conv.type !== "dm" && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (confirm(`Leave ${title}?`)) onLeave(conv);
            }}
          >
            Leave
          </button>
        )}
      </header>
      <div className="chat-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="empty">No messages yet — say hi.</p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} m={m} self={self} />)
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          trySend();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message — Enter to send"
          maxLength={4096}
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

function MessageRow({ m, self }: { m: MessageView; self: UserInfo }) {
  const mine = m.sender.id === self.id;
  return (
    <div className={`msg ${mine ? "msg-mine" : ""}`}>
      <div className="msg-meta">
        <span className="msg-sender">{mine ? "you" : m.sender.username}</span>
        <span className="msg-time">{formatTime(m.created_at)}</span>
      </div>
      <div className="msg-body">{m.body}</div>
    </div>
  );
}

// --- New Group form ---------------------------------------------------

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
    <section className="pane form-pane">
      <header className="form-header">
        <h2>New group</h2>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </header>
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
          <button type="submit" disabled={busy || selected.size === 0}>
            {busy ? "Creating…" : "Create group"}
          </button>
        </div>
      </form>
    </section>
  );
}

// --- New Room form ----------------------------------------------------

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
    <section className="pane form-pane">
      <header className="form-header">
        <h2>New room</h2>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </header>
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
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create room"}
          </button>
        </div>
      </form>
    </section>
  );
}

// --- Browse rooms -----------------------------------------------------

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
    <section className="pane form-pane">
      <header className="form-header">
        <h2>Browse rooms</h2>
        <button type="button" onClick={onCancel}>
          Close
        </button>
      </header>
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
                    # {r.name}{" "}
                    <span className="badge">{r.member_count}</span>
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
      </div>
    </section>
  );
}

// --- Helpers ----------------------------------------------------------

function sortByUsername(users: UserInfo[]): UserInfo[] {
  return [...users].sort((a, b) => a.username.localeCompare(b.username));
}

function sortConversations(convs: ConversationView[]): ConversationView[] {
  // /api/conversations already returns latest-first; if we built this
  // map from WS events on the fly, fall back to created_at then id.
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

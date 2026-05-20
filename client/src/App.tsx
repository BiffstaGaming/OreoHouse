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
  httpToWs,
  listConversations,
  listMessages,
  login,
  logout,
} from "./lib/api";
import { connect, type ConnectionStatus, type WSClient } from "./lib/ws";
import type {
  ConversationView,
  MessageView,
  OutgoingMessage,
  ServerMessage,
  UserInfo,
} from "./types/proto";

import "./App.css";

type Session = {
  serverUrl: string;
  token: string;
  user: UserInfo;
};

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
    <main className="phase3 login-screen">
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
  const [selectedConvID, setSelectedConvID] = useState<number | null>(null);
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

  // Open WS + fetch the conversation list once per session.
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
      if (existing.some((x) => x.id === m.id)) return prev; // dedupe
      const next = [...existing, view].sort((a, b) => a.id - b.id);
      const out = new Map(prev);
      out.set(m.conversation_id, next);
      return out;
    });
    setConversations((prev) => {
      if (prev.has(m.conversation_id)) return prev;
      // Unknown conversation — fetch list out-of-band.
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
      // Server returns DESC; flip to ASC for top-down rendering.
      const asc = [...rows].sort((a, b) => a.id - b.id);
      setMessages((prev) => {
        const out = new Map(prev);
        // Merge with anything appendMessage already inserted while
        // the request was in flight.
        const incoming = prev.get(convID) ?? [];
        const merged = mergeByID(asc, incoming);
        out.set(convID, merged);
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

  async function openDMWith(user: UserInfo) {
    if (user.id === session.user.id) return;
    try {
      const conv = await createDM(session.serverUrl, session.token, user.id);
      setConversations((prev) => {
        const out = new Map(prev);
        out.set(conv.id, conv);
        return out;
      });
      setSelectedConvID(conv.id);
      void ensureHistory(conv.id);
    } catch (err) {
      console.error("createDM failed:", err);
    }
  }

  function sendMessage(body: string) {
    if (!selectedConvID || !wsRef.current) return;
    wsRef.current.send({
      type: "message",
      conversation_id: selectedConvID,
      body,
    });
  }

  async function handleSignOut() {
    wsRef.current?.close();
    await logout(session.serverUrl, session.token);
    onSignOut();
  }

  const selectedConv = useMemo(
    () => (selectedConvID ? conversations.get(selectedConvID) ?? null : null),
    [selectedConvID, conversations],
  );
  const selectedMessages = useMemo(
    () => (selectedConvID ? messages.get(selectedConvID) ?? [] : []),
    [selectedConvID, messages],
  );

  return (
    <main className="phase3 chat-screen">
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
        <PresencePane
          online={online}
          self={session.user}
          selectedConvID={selectedConvID}
          conversations={conversations}
          onPickUser={openDMWith}
        />
        <ChatPane
          self={session.user}
          conv={selectedConv}
          messages={selectedMessages}
          onSend={sendMessage}
        />
      </div>
    </main>
  );
}

function PresencePane({
  online,
  self,
  selectedConvID,
  conversations,
  onPickUser,
}: {
  online: UserInfo[];
  self: UserInfo;
  selectedConvID: number | null;
  conversations: Map<number, ConversationView>;
  onPickUser: (u: UserInfo) => void;
}) {
  // Identify the "other party" for the currently selected DM so we can
  // highlight that user in the list.
  const selectedOther =
    selectedConvID && conversations.has(selectedConvID)
      ? otherDMMember(conversations.get(selectedConvID)!, self.id)
      : null;

  return (
    <aside className="pane presence-pane">
      <h2>
        Online — <span className="count">{online.length}</span>
      </h2>
      {online.length === 0 ? (
        <p className="empty">Nobody else is here.</p>
      ) : (
        <ul className="presence-list">
          {online.map((u) => {
            const isSelf = u.id === self.id;
            const isSelected = selectedOther?.id === u.id;
            return (
              <li
                key={u.id}
                className={
                  (isSelf ? "self " : "") + (isSelected ? "selected" : "")
                }
              >
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

function ChatPane({
  self,
  conv,
  messages,
  onSend,
}: {
  self: UserInfo;
  conv: ConversationView | null;
  messages: MessageView[];
  onSend: (body: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll to the bottom whenever messages change (Phase 6 will make
  // this smarter — only when already at the bottom, with a "new
  // messages" jump-down button otherwise).
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, conv?.id]);

  if (!conv) {
    return (
      <section className="pane chat-pane chat-pane-empty">
        <p>Pick a person on the left to start a chat.</p>
      </section>
    );
  }

  const title = conversationTitle(conv, self.id);

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
        <h2>{title}</h2>
      </header>
      <div className="chat-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="empty">No messages yet — say hi.</p>
        ) : (
          messages.map((m) => (
            <MessageRow key={m.id} m={m} self={self} />
          ))
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

function sortByUsername(users: UserInfo[]): UserInfo[] {
  return [...users].sort((a, b) => a.username.localeCompare(b.username));
}

function otherDMMember(
  conv: ConversationView,
  selfID: number,
): UserInfo | null {
  if (conv.type !== "dm") return null;
  return conv.members.find((m) => m.id !== selfID) ?? null;
}

function conversationTitle(conv: ConversationView, selfID: number): string {
  if (conv.name) return conv.name;
  const other = otherDMMember(conv, selfID);
  return other ? other.username : `Conversation #${conv.id}`;
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

// mergeByID returns a new ascending-by-id list with no duplicate ids.
// Used to reconcile a fetched history page with any messages that
// arrived live while the request was in flight.
function mergeByID(a: MessageView[], b: MessageView[]): MessageView[] {
  const byID = new Map<number, MessageView>();
  for (const m of a) byID.set(m.id, m);
  for (const m of b) byID.set(m.id, m);
  return Array.from(byID.values()).sort((x, y) => x.id - y.id);
}

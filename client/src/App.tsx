import { useEffect, useRef, useState, type FormEvent } from "react";

import { httpToWs, login, logout } from "./lib/api";
import { connect, type ConnectionStatus, type WSClient } from "./lib/ws";
import type { ServerMessage, UserInfo } from "./types/proto";

import "./App.css";

type Session = {
  serverUrl: string;
  token: string;
  user: UserInfo;
};

const DEFAULT_SERVER_URL = "http://localhost:8080";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  if (!session) {
    return <LoginScreen onSession={setSession} />;
  }
  return (
    <PresenceScreen
      session={session}
      onSignOut={() => setSession(null)}
    />
  );
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
      // Clear the password from React state — Tauri stores everything
      // in process memory but no point hanging on to it longer than we
      // need.
      setPassword("");
      onSession({ serverUrl, token: resp.token, user: resp.user });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="phase2 login-screen">
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

function PresenceScreen({
  session,
  onSignOut,
}: {
  session: Session;
  onSignOut: () => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [online, setOnline] = useState<UserInfo[]>([]);
  const wsRef = useRef<WSClient | null>(null);

  useEffect(() => {
    let wsUrl: string;
    try {
      wsUrl = httpToWs(session.serverUrl, session.token);
    } catch (err) {
      console.error("ws: bad server URL", err);
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
      case "error":
        console.error("ws error", msg.code, msg.message);
        return;
      case "pong":
        return;
    }
  }

  async function handleSignOut() {
    wsRef.current?.close();
    await logout(session.serverUrl, session.token);
    onSignOut();
  }

  return (
    <main className="phase2 main-screen">
      <header className="topbar">
        <div className="me">
          <strong>{session.user.username}</strong>
          <span className={`ws-status ws-status-${status}`}>{status}</span>
        </div>
        <button type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <section>
        <h2>
          Online — <span className="count">{online.length}</span>
        </h2>
        {online.length === 0 ? (
          <p className="empty">Nobody else is here. Try connecting from another machine.</p>
        ) : (
          <ul className="presence-list">
            {online.map((u) => (
              <li
                key={u.id}
                className={u.id === session.user.id ? "self" : ""}
              >
                <span className="dot" />
                {u.username}
                {u.id === session.user.id ? " (you)" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="hint">
        Chat lands in Phase 3. For now this screen just reflects live presence.
      </p>
    </main>
  );
}

function sortByUsername(users: UserInfo[]): UserInfo[] {
  return [...users].sort((a, b) => a.username.localeCompare(b.username));
}

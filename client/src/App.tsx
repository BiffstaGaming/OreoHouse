import { useEffect, useRef, useState } from "react";
import "./App.css";

type Status = "idle" | "connecting" | "open" | "closed" | "error";

type Direction = "in" | "out" | "system";

type LogEntry = {
  id: number;
  direction: Direction;
  text: string;
};

const DEFAULT_SERVER_URL = "http://localhost:8080";
const INITIAL_PAYLOAD = JSON.stringify({ hello: "world" }, null, 2);

function httpToWs(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [status, setStatus] = useState<Status>("idle");
  const [payload, setPayload] = useState(INITIAL_PAYLOAD);
  const [log, setLog] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const idRef = useRef(0);

  useEffect(() => () => wsRef.current?.close(), []);

  function append(direction: Direction, text: string) {
    idRef.current += 1;
    const entry: LogEntry = { id: idRef.current, direction, text };
    setLog((prev) => [...prev, entry]);
  }

  function connect() {
    wsRef.current?.close();

    let wsUrl: string;
    try {
      wsUrl = httpToWs(serverUrl);
    } catch (err) {
      append("system", `Invalid URL: ${(err as Error).message}`);
      setStatus("error");
      return;
    }

    setStatus("connecting");
    append("system", `Connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("open");
      append("system", "WebSocket open");
    };
    ws.onmessage = (event) => {
      const text =
        typeof event.data === "string" ? event.data : "[binary message]";
      append("in", text);
    };
    ws.onerror = () => {
      setStatus("error");
      append("system", "WebSocket error");
    };
    ws.onclose = (event) => {
      setStatus("closed");
      append("system", `WebSocket closed (code ${event.code})`);
    };
  }

  function disconnect() {
    wsRef.current?.close();
  }

  function send() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      append("system", "Not connected");
      return;
    }
    try {
      JSON.parse(payload);
    } catch (err) {
      append("system", `Invalid JSON: ${(err as Error).message}`);
      return;
    }
    ws.send(payload);
    append("out", payload);
  }

  return (
    <main className="phase0">
      <h1>OreoHouse — Phase 0</h1>
      <p className="subtitle">Smoke-test client for the /ws echo endpoint.</p>

      <section className="conn">
        <label className="url-label">
          Server URL
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          onClick={connect}
          disabled={status === "connecting"}
        >
          Connect
        </button>
        <button
          type="button"
          onClick={disconnect}
          disabled={status !== "open"}
        >
          Disconnect
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </section>

      <section className="send">
        <label>
          JSON to send
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={6}
            spellCheck={false}
          />
        </label>
        <button type="button" onClick={send} disabled={status !== "open"}>
          Send
        </button>
      </section>

      <section className="log">
        <h2>Messages</h2>
        <ol>
          {log.map((entry) => (
            <li key={entry.id} className={`entry entry-${entry.direction}`}>
              <span className="direction">{entry.direction}</span>
              <pre>{entry.text}</pre>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

import type { ClientMessage, ServerMessage } from "../types/proto";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export interface WSClient {
  /** Closes the connection and stops the reconnect loop. Safe from any state. */
  close(): void;
  /** Sends a client message if the live socket is open; otherwise drops it. */
  send(msg: ClientMessage): void;
}

export interface WSHandlers {
  onOpen?: () => void;
  onMessage: (msg: ServerMessage) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

// Cap so a long outage doesn't push the retry interval to minutes.
// The web client uses 10 s; we go to 30 s on desktop because a stuck
// tray client can afford to wait a bit longer between attempts.
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

// connect opens a WebSocket to wsUrl and dispatches incoming messages
// to handlers.onMessage. On any unexpected close (server restart,
// network blip, sleep/wake) the wrapper reconnects automatically with
// capped exponential backoff (1s → 2s → 4s → … → 30s) and the caller
// sees onOpen fire again on the fresh socket. The server replays
// missed messages from the per-member delivery cursor, so callers
// don't need to re-fetch history themselves.
//
// onClose still fires every time the live socket dies — wire it to a
// "connecting" status badge so the user can see the reconnect attempt
// in flight. Calling close() on the returned client marks the loop
// permanently stopped, so signing out doesn't leak a retry timer.
export function connect(wsUrl: string, handlers: WSHandlers): WSClient {
  let sock: WebSocket | null = null;
  let closed = false;
  let retryTimer: number | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;

  function openSocket() {
    if (closed) return;
    const ws = new WebSocket(wsUrl);
    sock = ws;

    ws.onopen = () => {
      backoffMs = INITIAL_BACKOFF_MS;
      handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        handlers.onMessage(msg);
      } catch (err) {
        console.error("ws: failed to parse message", err, ev.data);
      }
    };
    ws.onclose = (ev) => {
      // Always tell the caller the live socket just died — even if
      // we're going to reconnect, it's the cue to flip the status
      // badge back to "connecting".
      handlers.onClose?.(ev);
      if (closed) return;
      const delay = backoffMs;
      backoffMs = Math.min(delay * 2, MAX_BACKOFF_MS);
      retryTimer = window.setTimeout(openSocket, delay);
    };
    ws.onerror = (ev) => handlers.onError?.(ev);
  }

  openSocket();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        sock?.close();
      } catch {
        /* ignore */
      }
    },
    send(msg: ClientMessage) {
      if (sock?.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(msg));
      }
    },
  };
}

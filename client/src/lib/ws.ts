import type { ClientMessage, ServerMessage } from "../types/proto";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export interface WSClient {
  /** Closes the connection. Safe to call from any state. */
  close(): void;
  /** Sends a client message if the connection is open; otherwise drops it. */
  send(msg: ClientMessage): void;
}

export interface WSHandlers {
  onOpen?: () => void;
  onMessage: (msg: ServerMessage) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

// connect opens a WebSocket to wsUrl and dispatches incoming messages
// to handlers.onMessage. The returned WSClient owns the socket — call
// close() to dispose of it.
export function connect(wsUrl: string, handlers: WSHandlers): WSClient {
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => handlers.onOpen?.();
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as ServerMessage;
      handlers.onMessage(msg);
    } catch (err) {
      console.error("ws: failed to parse message", err, ev.data);
    }
  };
  ws.onclose = (ev) => handlers.onClose?.(ev);
  ws.onerror = (ev) => handlers.onError?.(ev);

  return {
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
    send(msg: ClientMessage) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
  };
}

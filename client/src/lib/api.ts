import type {
  ErrorResponse,
  LoginRequest,
  LoginResponse,
} from "../types/proto";

// login POSTs /api/auth/login and returns the parsed body on 200. On
// 4xx/5xx it throws an Error whose message is taken from the JSON
// `error` field when present, or `HTTP <status>` otherwise.
export async function login(
  serverUrl: string,
  req: LoginRequest,
): Promise<LoginResponse> {
  const url = new URL("/api/auth/login", serverUrl);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as ErrorResponse;
      if (body.error) msg = body.error;
    } catch {
      /* body wasn't JSON, keep the HTTP <status> fallback */
    }
    throw new Error(msg);
  }
  return (await resp.json()) as LoginResponse;
}

// logout POSTs /api/auth/logout. Idempotent on the server side, so we
// swallow any errors here too — the local session is already gone.
export async function logout(
  serverUrl: string,
  token: string,
): Promise<void> {
  const url = new URL("/api/auth/logout", serverUrl);
  try {
    await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* network failure on logout shouldn't block the UI flow */
  }
}

// httpToWs derives the WS URL for /ws from the HTTP server URL and
// the session token. Throws if serverUrl is not a valid URL.
export function httpToWs(serverUrl: string, token: string): string {
  const url = new URL("/ws", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

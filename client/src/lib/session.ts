// Persisted session — token, server URL, and the UserInfo that came
// back from /api/auth/login. Stored in localStorage so the app
// auto-resumes on next launch instead of asking for a password every
// restart.
//
// The token itself is opaque and revocable server-side; if it's been
// expired or revoked, the first authenticated REST call will return
// 401 and the app clears storage and bounces back to login.

import type { UserInfo } from "../types/proto";

const KEY = "oreohouse-session-v1";

export type StoredSession = {
  serverUrl: string;
  token: string;
  user: UserInfo;
};

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.serverUrl === "string" &&
      typeof parsed.token === "string" &&
      parsed.user &&
      typeof parsed.user.id === "number" &&
      typeof parsed.user.username === "string"
    ) {
      return parsed as StoredSession;
    }
  } catch {
    /* corrupt — drop it */
  }
  return null;
}

export function saveSession(s: StoredSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full / disabled — ignore, session lives only in memory */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// LAST_SERVER_KEY remembers the most recently used server URL even
// after sign-out, so the login form pre-fills sensibly on next launch.
const LAST_SERVER_KEY = "oreohouse-last-server-url";

export function loadLastServerUrl(): string | null {
  try {
    return localStorage.getItem(LAST_SERVER_KEY);
  } catch {
    return null;
  }
}

export function saveLastServerUrl(url: string): void {
  try {
    localStorage.setItem(LAST_SERVER_KEY, url);
  } catch {
    /* ignore */
  }
}

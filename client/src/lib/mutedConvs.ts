// Tiny localStorage-backed set of muted conversation IDs. When a
// conv is muted, the client (main window + chat window) suppress
// sound, taskbar flash, and the unread badge for that conv's
// incoming messages. State is per-machine; not synced to the server.

const KEY = "oreohouse-muted-convs";

export function loadMutedConvs(): Set<number> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((n): n is number => typeof n === "number"));
  } catch {
    return new Set();
  }
}

export function saveMutedConvs(set: Set<number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(set)));
  } catch {
    /* ignore */
  }
}

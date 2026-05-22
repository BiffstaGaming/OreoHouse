// Per-conversation composer draft persistence.
//
// Stash unsent text in localStorage so closing a chat window
// mid-sentence doesn't throw the message away. Keyed by
// conversation id; one entry per conversation. Cleared on a
// successful send (or any explicit clear).
//
// Storage cap: drafts are trimmed to 8 kB so a runaway paste can't
// fill localStorage. The composer's own maxlength keeps this well
// under the limit in practice.

const STORAGE_KEY_PREFIX = "oreohouse:draft:";
const MAX_BYTES = 8 * 1024;

function key(conversationID: number): string {
  return STORAGE_KEY_PREFIX + conversationID;
}

export function loadDraft(conversationID: number): string {
  try {
    return localStorage.getItem(key(conversationID)) ?? "";
  } catch {
    // Private-mode browsers can throw on storage access. Caller treats
    // missing draft as empty string anyway.
    return "";
  }
}

export function saveDraft(conversationID: number, body: string): void {
  try {
    if (!body) {
      localStorage.removeItem(key(conversationID));
      return;
    }
    const trimmed = body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body;
    localStorage.setItem(key(conversationID), trimmed);
  } catch {
    /* storage full or denied — degrade silently */
  }
}

export function clearDraft(conversationID: number): void {
  try {
    localStorage.removeItem(key(conversationID));
  } catch {
    /* ignore */
  }
}

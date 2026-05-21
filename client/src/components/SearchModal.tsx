// Cross-conversation message search. Opens from the topbar 🔍 button,
// debounces the query (~250 ms), shows newest-first results with the
// originating conversation name + a 200-char body preview. Clicking
// a result opens that conversation's chat window in the foreground.

import { useEffect, useRef, useState } from "react";

import { searchMessages } from "../lib/api";
import { displayNameOf } from "../lib/users";
import type { ConversationView, MessageView, UserInfo } from "../types/proto";

export function SearchModal({
  serverUrl,
  token,
  conversations,
  userCache,
  self,
  onClose,
  onJump,
}: {
  serverUrl: string;
  token: string;
  conversations: Map<number, ConversationView>;
  userCache: Map<number, UserInfo>;
  self: UserInfo;
  onClose: () => void;
  onJump: (convID: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus immediately on open + Escape to close.
  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced query: each keystroke schedules a 250 ms timeout; new
  // strokes cancel the previous timer so we only fire once.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setError(null);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const rows = await searchMessages(serverUrl, token, query.trim());
        setResults(rows);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, serverUrl, token]);

  function convLabel(convID: number): string {
    const c = conversations.get(convID);
    if (!c) return "Unknown conversation";
    if (c.type === "dm") {
      const other = c.members.find((m) => m.id !== self.id);
      return other ? displayNameOf(other) : "DM";
    }
    return c.name || (c.type === "room" ? "Room" : "Group");
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal search-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Search messages</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type at least one word…"
            autoComplete="off"
            spellCheck={false}
          />
          {error && <div className="error">{error}</div>}
          {loading && <p className="empty">Searching…</p>}
          {!loading && query.trim().length > 0 && results.length === 0 && !error && (
            <p className="empty">No matches.</p>
          )}
          {results.length > 0 && (
            <ul className="search-results">
              {results.map((m) => {
                const q = query.trim().toLowerCase();
                const bodyHit =
                  m.body !== undefined &&
                  m.body !== null &&
                  m.body.toLowerCase().includes(q);
                // A "filename hit" is anything matched purely on the
                // attachment side — likely the case if the body
                // doesn't contain the query but an attachment does.
                const filenameHits = (m.attachments ?? []).filter((a) =>
                  a.filename.toLowerCase().includes(q),
                );
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="search-result"
                      onClick={() => {
                        onJump(m.conversation_id);
                        onClose();
                      }}
                    >
                      <div className="search-result-meta">
                        <span className="search-result-conv">
                          {convLabel(m.conversation_id)}
                        </span>
                        <span className="search-result-sender">
                          {displayNameOf(userCache.get(m.sender.id) ?? m.sender)}
                        </span>
                        <span className="search-result-time">
                          {new Date(m.created_at).toLocaleString()}
                        </span>
                      </div>
                      {m.body && (
                        <div className="search-result-body">{m.body}</div>
                      )}
                      {filenameHits.length > 0 && !bodyHit && (
                        <div className="search-result-files">
                          <span className="search-result-files-icon">📎</span>
                          {filenameHits
                            .map((a) => a.filename)
                            .join(", ")}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

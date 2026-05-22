// 3-dot conversation actions menu shown in the chat-window header.
// Matches the web client's openConvActionsMenu (app.js:2443).
//
// Items shown depend on conversation type:
//   - groups/rooms: Rename, Change topic, Manage members, Export, Leave
//   - DMs:          Export only (you can't rename or kick from a DM)
//
// Open + close is owned by the parent; this component just renders
// the popover when `open` is true.

import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  kickMember,
  listMessages,
  updateConversation,
} from "../lib/api";
import { displayNameOf } from "../lib/users";
import type {
  ConversationView,
  MessageView,
  UserInfo,
} from "../types/proto";

type Props = {
  open: boolean;
  conv: ConversationView;
  self: UserInfo;
  serverUrl: string;
  token: string;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConversationUpdated: (next: ConversationView) => void;
  onLeave: () => void;
};

type Modal = null | "rename" | "topic" | "members";

export function ConvActionsMenu({
  open,
  conv,
  self,
  serverUrl,
  token,
  anchorRef,
  onClose,
  onConversationUpdated,
  onLeave,
}: Props) {
  const [modal, setModal] = useState<Modal>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on click-outside or Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      const t = ev.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    // Defer to next tick so the click that opened us doesn't fire onDocClick.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDocClick, true);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose]);

  const isGroupOrRoom = conv.type !== "dm";

  return (
    <>
      {open && (
        <div className="conv-actions-menu" ref={menuRef} role="menu">
          {isGroupOrRoom && (
            <>
              <button
                type="button"
                className="conv-actions-item"
                onClick={() => { onClose(); setModal("rename"); }}
              >
                ✏️ Rename conversation
              </button>
              <button
                type="button"
                className="conv-actions-item"
                onClick={() => { onClose(); setModal("topic"); }}
              >
                💬 Change topic
              </button>
              <button
                type="button"
                className="conv-actions-item"
                onClick={() => { onClose(); setModal("members"); }}
              >
                👥 Manage members
              </button>
              <div className="conv-actions-sep" />
            </>
          )}
          <button
            type="button"
            className="conv-actions-item"
            onClick={() => { onClose(); void exportConversation(serverUrl, token, conv, self); }}
          >
            💾 Export conversation
          </button>
          {isGroupOrRoom && (
            <>
              <div className="conv-actions-sep" />
              <button
                type="button"
                className="conv-actions-item conv-actions-danger"
                onClick={() => { onClose(); onLeave(); }}
              >
                🚪 Leave conversation
              </button>
            </>
          )}
        </div>
      )}

      {modal === "rename" && (
        <RenameModal
          conv={conv}
          serverUrl={serverUrl}
          token={token}
          onClose={() => setModal(null)}
          onSaved={(next) => { onConversationUpdated(next); setModal(null); }}
        />
      )}
      {modal === "topic" && (
        <TopicModal
          conv={conv}
          serverUrl={serverUrl}
          token={token}
          onClose={() => setModal(null)}
          onSaved={(next) => { onConversationUpdated(next); setModal(null); }}
        />
      )}
      {modal === "members" && (
        <ManageMembersModal
          conv={conv}
          self={self}
          serverUrl={serverUrl}
          token={token}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

// -------- Rename --------------------------------------------------

function RenameModal({
  conv,
  serverUrl,
  token,
  onClose,
  onSaved,
}: {
  conv: ConversationView;
  serverUrl: string;
  token: string;
  onClose: () => void;
  onSaved: (next: ConversationView) => void;
}) {
  const [name, setName] = useState(conv.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await updateConversation(serverUrl, token, conv.id, {
        name: name.trim(),
      });
      onSaved(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Rename conversation</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <form className="modal-body form" onSubmit={submit}>
          <label>
            New name
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Conversation name"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------- Topic ---------------------------------------------------

function TopicModal({
  conv,
  serverUrl,
  token,
  onClose,
  onSaved,
}: {
  conv: ConversationView;
  serverUrl: string;
  token: string;
  onClose: () => void;
  onSaved: (next: ConversationView) => void;
}) {
  const [topic, setTopic] = useState(conv.topic ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await updateConversation(serverUrl, token, conv.id, {
        topic: topic.trim(),
      });
      onSaved(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Change topic</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <form className="modal-body form" onSubmit={submit}>
          <label>
            Topic <span className="hint">(empty clears)</span>
            <input
              ref={inputRef}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={160}
              placeholder="What's this conversation about?"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------- Manage members -----------------------------------------

function ManageMembersModal({
  conv,
  self,
  serverUrl,
  token,
  onClose,
}: {
  conv: ConversationView;
  self: UserInfo;
  serverUrl: string;
  token: string;
  onClose: () => void;
}) {
  const [busyID, setBusyID] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function kick(userID: number, label: string) {
    if (!confirm(`Remove ${label} from this conversation?`)) return;
    setBusyID(userID);
    setError(null);
    try {
      await kickMember(serverUrl, token, conv.id, userID);
      // The server will broadcast conversation_members_changed and the
      // App's handler will refresh the conv. Close the modal so the
      // user sees the updated header.
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyID(null);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Members</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">
          <ul className="manage-members-list">
            {conv.members.map((m) => {
              const isMe = m.id === self.id;
              const label = displayNameOf(m) + (isMe ? " (you)" : "");
              return (
                <li key={m.id} className="manage-members-row">
                  <span className="manage-members-name">{label}</span>
                  {!isMe && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void kick(m.id, displayNameOf(m))}
                      disabled={busyID !== null}
                    >
                      {busyID === m.id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {error && <div className="error">{error}</div>}
          <div className="form-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------- Export --------------------------------------------------

// Walks the message history backwards from newest in pages of 100,
// then renders to a markdown-ish .txt file and triggers a download.
// Caps at 20 000 messages (200 pages) to bound the worst case for a
// long-running room.
async function exportConversation(
  serverUrl: string,
  token: string,
  conv: ConversationView,
  self: UserInfo,
): Promise<void> {
  const all: MessageView[] = [];
  let before = 0;
  for (let page = 0; page < 200; page++) {
    let batch: MessageView[];
    try {
      batch = await listMessages(serverUrl, token, conv.id, before, 100);
    } catch (err) {
      alert("Export failed: " + (err as Error).message);
      return;
    }
    if (batch.length === 0) break;
    all.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  // Oldest first reads more naturally.
  all.reverse();

  const title =
    conv.type === "dm"
      ? "DM with " +
        (conv.members.find((m) => m.id !== self.id)?.username ?? "unknown")
      : conv.name || (conv.type === "room" ? "Room" : "Group");

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push(`Exported ${new Date().toISOString()} by ${self.username}`);
  lines.push("");
  for (const m of all) {
    const when = new Date(m.created_at).toLocaleString();
    const who = displayNameOf(m.sender);
    const body = m.body ?? "";
    lines.push(`[${when}] ${who}: ${body}`);
    if (m.attachments && m.attachments.length > 0) {
      for (const a of m.attachments) {
        lines.push(`    📎 ${a.filename} (${a.mime_type})`);
      }
    }
    if (m.deleted_at) lines.push("    (deleted)");
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeTitle = title.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 60) || "conversation";
  a.href = url;
  a.download = `oreohouse-${safeTitle}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

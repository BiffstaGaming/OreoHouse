// Per-conversation media + links gallery.
//
// Opens from the chat window header button. Two tabs:
//
//   - Media: every image / file ever shared in the conv, newest first,
//            with image previews and download chips for non-images.
//   - Links: every URL that has ever appeared in a message body,
//            extracted server-side and grouped by message.
//
// Backed by GET /api/conversations/{id}/media + .../links. Renders in
// a side-drawer over the chat window; closes on ✕ or backdrop click.

import { useEffect, useState } from "react";

import {
  fileURL,
  listConversationLinks,
  listConversationMedia,
} from "../lib/api";
import { displayNameOf } from "../lib/users";
import type { LinkItem, MediaItem, UserInfo } from "../types/proto";

type Tab = "media" | "links";

function isImage(mime: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function MediaLinksPanel({
  serverUrl,
  token,
  conversationID,
  userCache,
  onClose,
}: {
  serverUrl: string;
  token: string;
  conversationID: number;
  userCache: Map<number, UserInfo>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("media");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape to close — mirrors the rest of the modals in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load whichever tab is active. The other tab loads lazily when
  // selected — no point hitting both endpoints if you only wanted
  // media.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (tab === "media") {
          const items = await listConversationMedia(
            serverUrl,
            token,
            conversationID,
          );
          if (!cancelled) setMedia(items);
        } else {
          const items = await listConversationLinks(
            serverUrl,
            token,
            conversationID,
          );
          if (!cancelled) setLinks(items);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tab, serverUrl, token, conversationID]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal media-links-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Media &amp; Links</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="ml-tabs">
          <button
            type="button"
            className={"ml-tab" + (tab === "media" ? " ml-tab-active" : "")}
            onClick={() => setTab("media")}
          >
            Media
          </button>
          <button
            type="button"
            className={"ml-tab" + (tab === "links" ? " ml-tab-active" : "")}
            onClick={() => setTab("links")}
          >
            Links
          </button>
        </div>
        <div className="modal-body">
          {loading && <p className="empty">Loading…</p>}
          {error && <div className="error">{error}</div>}
          {!loading && !error && tab === "media" && (
            <MediaTab
              items={media}
              serverUrl={serverUrl}
              token={token}
              userCache={userCache}
            />
          )}
          {!loading && !error && tab === "links" && (
            <LinksTab items={links} userCache={userCache} />
          )}
        </div>
      </div>
    </div>
  );
}

function MediaTab({
  items,
  serverUrl,
  token,
  userCache,
}: {
  items: MediaItem[];
  serverUrl: string;
  token: string;
  userCache: Map<number, UserInfo>;
}) {
  if (items.length === 0) {
    return <p className="empty">No media shared in this conversation yet.</p>;
  }

  const images = items.filter((i) => isImage(i.attachment.mime_type));
  const files = items.filter((i) => !isImage(i.attachment.mime_type));

  return (
    <div className="ml-media">
      {images.length > 0 && (
        <>
          <h3 className="ml-section-title">Photos &amp; videos</h3>
          <div className="ml-image-grid">
            {images.map((item) => (
              <a
                key={item.attachment.id}
                className="ml-image-tile"
                href={fileURL(serverUrl, token, item.attachment.id)}
                target="_blank"
                rel="noopener noreferrer"
                title={`${item.attachment.filename} — ${displayNameOf(
                  userCache.get(item.sender.id) ?? item.sender,
                )} • ${formatDate(item.created_at)}`}
              >
                <img
                  src={fileURL(serverUrl, token, item.attachment.id)}
                  alt={item.attachment.filename}
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        </>
      )}
      {files.length > 0 && (
        <>
          <h3 className="ml-section-title">Files</h3>
          <ul className="ml-file-list">
            {files.map((item) => (
              <li key={item.attachment.id}>
                <a
                  className="ml-file-row"
                  href={fileURL(serverUrl, token, item.attachment.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="ml-file-icon">📎</span>
                  <span className="ml-file-meta">
                    <span className="ml-file-name">
                      {item.attachment.filename}
                    </span>
                    <span className="ml-file-sub">
                      {displayNameOf(
                        userCache.get(item.sender.id) ?? item.sender,
                      )}{" "}
                      • {formatDate(item.created_at)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function LinksTab({
  items,
  userCache,
}: {
  items: LinkItem[];
  userCache: Map<number, UserInfo>;
}) {
  if (items.length === 0) {
    return <p className="empty">No links shared in this conversation yet.</p>;
  }
  return (
    <ul className="ml-link-list">
      {items.map((l, i) => (
        <li key={`${l.message_id}-${i}-${l.url}`}>
          <a
            className="ml-link-row"
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            title={l.url}
          >
            <span className="ml-link-host">{hostnameOf(l.url)}</span>
            <span className="ml-link-url">{l.url}</span>
            <span className="ml-link-sub">
              {displayNameOf(userCache.get(l.sender.id) ?? l.sender)} •{" "}
              {formatDate(l.created_at)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

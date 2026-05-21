// Inline profile editor: display name + avatar upload. Opens from the
// StatusMenu's "Edit profile" link. Calls REST directly; the server
// broadcasts user_profile_changed to every client (including ours),
// which is how the parent App refreshes its own copy of the session.

import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  deleteMyAvatar,
  setMyDisplayName,
  uploadMyAvatar,
} from "../lib/api";
import { THEMES, type ThemeName } from "../lib/theme";
import type { UserInfo } from "../types/proto";

import { Avatar } from "./Avatar";

export function ProfileModal({
  me,
  serverUrl,
  token,
  theme,
  onThemeChange,
  onClose,
}: {
  me: UserInfo;
  serverUrl: string;
  token: string;
  theme: ThemeName;
  onThemeChange: (next: ThemeName) => void;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState(me.display_name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UserInfo>(me);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handlePickFile() {
    fileRef.current?.click();
  }

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const updated = await uploadMyAvatar(serverUrl, token, file);
      setPreview(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAvatar() {
    setError(null);
    setBusy(true);
    try {
      const updated = await deleteMyAvatar(serverUrl, token);
      setPreview(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await setMyDisplayName(serverUrl, token, displayName.trim());
      onClose();
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
          <h2>Edit profile</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          <form className="form profile-form" onSubmit={handleSubmit}>
            <div className="profile-avatar-row">
              {/* Bust the cache after every avatar change so the
                  preview updates without a hard reload. */}
              <Avatar
                key={`${preview.has_avatar}-${Date.now()}`}
                user={preview}
                serverUrl={serverUrl}
                token={token}
                size={96}
              />
              <div className="profile-avatar-actions">
                <button
                  type="button"
                  onClick={handlePickFile}
                  disabled={busy}
                >
                  {preview.has_avatar ? "Change avatar" : "Upload avatar"}
                </button>
                {preview.has_avatar && (
                  <button
                    type="button"
                    className="danger"
                    onClick={handleClearAvatar}
                    disabled={busy}
                  >
                    Remove
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      void handleFile(e.target.files[0]);
                      e.target.value = "";
                    }
                  }}
                />
              </div>
            </div>
            <label>
              Display name <span className="hint">(optional)</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={64}
                placeholder={me.username}
                autoComplete="off"
              />
            </label>
            <fieldset className="theme-picker">
              <legend>Theme</legend>
              <div className="theme-options">
                {THEMES.map((t) => (
                  <label
                    key={t.name}
                    className={
                      "theme-option" +
                      (theme === t.name ? " theme-option-active" : "")
                    }
                  >
                    <input
                      type="radio"
                      name="oreo-theme"
                      value={t.name}
                      checked={theme === t.name}
                      onChange={() => onThemeChange(t.name)}
                    />
                    <span className={`theme-swatch theme-swatch-${t.name}`} />
                    <span className="theme-meta">
                      <span className="theme-label">{t.label}</span>
                      <span className="theme-tagline">{t.tagline}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <div className="error">{error}</div>}
            <div className="form-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Close
              </button>
              <button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

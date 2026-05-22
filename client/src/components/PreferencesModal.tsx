// Per-machine UX preferences: theme picker + sound toggle.
//
// Mirrors web/public/assets/js/app.js openPreferencesModal so the
// two clients share one mental model. Sound mute is the same boolean
// the topbar 🔊/🔇 button drives — opening this modal and toggling
// the checkbox is equivalent to clicking that button.
//
// Theme picker was originally inside ProfileModal; pulling it out so
// the Profile modal can shrink back to just display-name + avatar
// (web app did the same in PR #18).

import { useEffect } from "react";

import { THEMES, type ThemeName } from "../lib/theme";

type Props = {
  theme: ThemeName;
  soundsMuted: boolean;
  onThemeChange: (next: ThemeName) => void;
  onSoundsMutedChange: (muted: boolean) => void;
  onClose: () => void;
};

export function PreferencesModal({
  theme,
  soundsMuted,
  onThemeChange,
  onSoundsMutedChange,
  onClose,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Preferences</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">
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
                    name="oreohouse-prefs-theme"
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

          <fieldset className="theme-picker">
            <legend>Sounds</legend>
            <label className="prefs-toggle">
              <input
                type="checkbox"
                checked={!soundsMuted}
                onChange={(e) => onSoundsMutedChange(!e.target.checked)}
              />
              <span>
                <strong>Sound effects</strong>
                <br />
                <span className="prefs-toggle-help">
                  Message blips, nudges, sign-in chimes, reaction pops.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="form-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

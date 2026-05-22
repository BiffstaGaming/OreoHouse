// /help slash-command cheat-sheet. Pops when the user sends "/help"
// in any composer. Mirrors web's openSlashHelpModal (app.js:2316).

import { useEffect } from "react";

import { SLASH_HELP_ROWS } from "../lib/slashCommands";

export function SlashHelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal shortcuts-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Slash commands</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">
          <p className="about-blurb">
            Type one of these in the composer. /me, /shrug, /tableflip, /unflip,
            /dice, /coin, /8ball, /time all expand to text. /help shows this
            list and is never sent.
          </p>
          <table className="shortcuts-table">
            <tbody>
              {SLASH_HELP_ROWS.map((row, i) => {
                const keys = row.slice(0, row.length - 1);
                const desc = row[row.length - 1];
                return (
                  <tr key={i}>
                    <td className="shortcut-key">
                      <kbd>{keys.join(" / ")}</kbd>
                    </td>
                    <td className="shortcut-desc">{desc}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="form-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

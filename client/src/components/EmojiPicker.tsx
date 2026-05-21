// Hand-rolled emoji picker. ~100 hand-picked common emoji across six
// categories, tabbed. Shared by the composer (insert into draft) and
// the reaction "…" overflow (toggle a reaction).

import { useEffect, useRef, useState } from "react";

import {
  EMOJI_CATEGORIES,
  loadRecentEmoji,
  pushRecentEmoji,
} from "../lib/emoji";

const RECENT_TAB_ID = "recent";

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (glyph: string) => void;
  onClose: () => void;
}) {
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmoji());
  // Start on Recent if we have any, otherwise on the first real
  // category. This way returning users see their favourites first.
  const [active, setActive] = useState(
    recent.length > 0 ? RECENT_TAB_ID : EMOJI_CATEGORIES[0].id,
  );
  const ref = useRef<HTMLDivElement | null>(null);

  function handlePick(glyph: string) {
    setRecent(pushRecentEmoji(glyph));
    onPick(glyph);
  }

  // Click-outside + Escape to dismiss.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Resolve the active tab's glyph list. "recent" is a synthetic tab
  // backed by localStorage; everything else looks up EMOJI_CATEGORIES.
  let glyphs: string[];
  if (active === RECENT_TAB_ID) {
    glyphs = recent;
  } else {
    const cat =
      EMOJI_CATEGORIES.find((c) => c.id === active) ?? EMOJI_CATEGORIES[0];
    glyphs = cat.glyphs;
  }

  return (
    <div className="emoji-picker" ref={ref} role="dialog">
      <div className="emoji-picker-tabs">
        {recent.length > 0 && (
          <button
            type="button"
            className={`emoji-picker-tab ${active === RECENT_TAB_ID ? "active" : ""}`}
            title="Recently used"
            onClick={() => setActive(RECENT_TAB_ID)}
          >
            🕒
          </button>
        )}
        {EMOJI_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`emoji-picker-tab ${c.id === active ? "active" : ""}`}
            title={c.label}
            onClick={() => setActive(c.id)}
          >
            {c.emoji}
          </button>
        ))}
      </div>
      <div className="emoji-picker-grid">
        {glyphs.length === 0 ? (
          <span className="emoji-picker-empty">No emoji yet.</span>
        ) : (
          glyphs.map((g) => (
            <button
              key={g}
              type="button"
              className="emoji-picker-glyph"
              onClick={() => handlePick(g)}
              title={g}
            >
              {g}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// Hand-rolled emoji picker. ~100 hand-picked common emoji across six
// categories, tabbed. Shared by the composer (insert into draft) and
// the reaction "…" overflow (toggle a reaction).

import { useEffect, useRef, useState } from "react";

import { EMOJI_CATEGORIES } from "../lib/emoji";

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (glyph: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(EMOJI_CATEGORIES[0].id);
  const ref = useRef<HTMLDivElement | null>(null);

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

  const cat = EMOJI_CATEGORIES.find((c) => c.id === active) ?? EMOJI_CATEGORIES[0];

  return (
    <div className="emoji-picker" ref={ref} role="dialog">
      <div className="emoji-picker-tabs">
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
        {cat.glyphs.map((g) => (
          <button
            key={g}
            type="button"
            className="emoji-picker-glyph"
            onClick={() => onPick(g)}
            title={g}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}

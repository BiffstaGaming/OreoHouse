// Hand-rolled emoji catalog used by the composer and reaction
// pickers. Ships ~100 hand-picked common emoji across six categories
// so users can stick with mouse if they want, while native Win+. or
// macOS Ctrl-Cmd-Space still works for everything else.

export type EmojiCategory = {
  id: string;
  label: string;
  emoji: string;
  glyphs: string[];
};

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    label: "Smileys",
    emoji: "😀",
    glyphs: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃",
      "😉", "😊", "😇", "🥰", "😍", "😘", "😋", "😜", "🤪", "😎",
      "🤩", "🥳", "😏", "😒", "🙄", "😬", "🤔", "😴", "🤤", "😪",
      "😭", "😢", "😤", "😡", "🤬", "🤯", "🥶", "🤒",
    ],
  },
  {
    id: "gestures",
    label: "Gestures",
    emoji: "👋",
    glyphs: [
      "👍", "👎", "👏", "🙌", "👋", "🤝", "🤞", "🤟", "🤘", "👌",
      "✌️", "🤙", "🫶", "💪", "🙏", "🫡", "🤷", "🤦",
    ],
  },
  {
    id: "hearts",
    label: "Hearts",
    emoji: "❤️",
    glyphs: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎",
      "💔", "❣️", "💕", "💞", "💖", "✨",
    ],
  },
  {
    id: "animals",
    label: "Animals",
    emoji: "🐶",
    glyphs: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🦁",
      "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🦄", "🐝", "🦋", "🐢",
    ],
  },
  {
    id: "food",
    label: "Food",
    emoji: "🍕",
    glyphs: [
      "🍕", "🍔", "🍟", "🌭", "🍿", "🧇", "🥞", "🥓", "🍳", "🍞",
      "🧀", "🥗", "🌮", "🌯", "🍣", "🍪", "🍩", "🎂", "🍰", "☕",
      "🍺", "🥂",
    ],
  },
  {
    id: "objects",
    label: "Objects",
    emoji: "🎉",
    glyphs: [
      "🎉", "🎊", "🎁", "🎈", "🎂", "🌟", "⭐", "🔥", "💯", "✅",
      "❌", "⚠️", "💡", "📌", "📎", "🔒", "🔑", "💻", "📱", "🎧",
      "🚀", "🏠",
    ],
  },
];

// Six quick reactions surfaced as the inline toolbar above each
// message. Picked to cover most of MSN-era reaction usage.
export const QUICK_REACTIONS: string[] = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

// ---- Recently used (persisted in localStorage) -----------------------

const RECENT_KEY = "oreohouse-recent-emoji";
const RECENT_MAX = 16;

// loadRecentEmoji returns the user's most-recently-used emoji,
// newest first. Empty array on a clean install or if storage is
// unavailable.
export function loadRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

// pushRecentEmoji bumps `glyph` to the front of the recent list,
// dedupes, and truncates to RECENT_MAX. Returns the new list so the
// caller can update React state without re-reading localStorage.
export function pushRecentEmoji(glyph: string): string[] {
  const current = loadRecentEmoji();
  const next = [glyph, ...current.filter((g) => g !== glyph)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

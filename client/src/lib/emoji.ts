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

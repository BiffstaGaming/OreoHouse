// Pure client-side slash-command expansion. If a draft begins with a
// known /command, expandSlashCommand transforms the body before it
// hits the WS — no schema changes, no server work. Unknown commands
// pass through unchanged so users can still talk about /dice without
// triggering it.

const EIGHT_BALL_ANSWERS = [
  "It is certain.",
  "Without a doubt.",
  "You may rely on it.",
  "Yes, definitely.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

// Result of expansion. `handled` means the command was recognised;
// `body` is the text to actually send (may be empty after expansion).
// `showHelp` short-circuits the send and tells the caller to pop the
// slash-command cheat-sheet modal instead.
export type SlashResult = { handled: boolean; body: string; showHelp?: boolean };

// Rows for the /help modal. First N-1 entries are the key strings (so
// aliases like /coin // /flip render as "/coin / /flip"); the last
// entry is the description.
export const SLASH_HELP_ROWS: string[][] = [
  ["/help", "Show this list of commands"],
  ["/dice [NdM]", "Roll N M-sided dice (default 1d6). e.g. /dice 2d6"],
  ["/coin", "/flip", "Flip a coin"],
  ["/8ball <q>", "Magic 8-ball oracle answer"],
  ["/me <text>", 'Action message: "* alice waves"'],
  ["/shrug [text]", "Append ¯\\_(ツ)_/¯ (optionally after your text)"],
  ["/tableflip [text]", "Append (╯°□°)╯︵ ┻━┻"],
  ["/unflip [text]", "Append ┬─┬ ノ( ゜-゜ノ)"],
  ["/time", "Insert the current local time"],
];

export function expandSlashCommand(input: string): SlashResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false, body: input };
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd.toLowerCase()) {
    case "help":
    case "commands":
      // Caller checks showHelp and opens the cheat-sheet modal.
      // Body stays empty so an accidental fall-through doesn't send.
      return { handled: true, body: "", showHelp: true };
    case "dice":
    case "roll": {
      // Optional NdM syntax (defaults to 1d6). Caps at 10 dice / d100.
      const m = arg.match(/^(\d+)?d?(\d+)?$/i);
      const n = clamp(parseInt(m?.[1] ?? "1", 10) || 1, 1, 10);
      const sides = clamp(parseInt(m?.[2] ?? "6", 10) || 6, 2, 100);
      const rolls: number[] = [];
      for (let i = 0; i < n; i++) {
        rolls.push(1 + Math.floor(Math.random() * sides));
      }
      const total = rolls.reduce((a, b) => a + b, 0);
      const detail = n === 1 ? "" : ` (${rolls.join(" + ")} = ${total})`;
      return {
        handled: true,
        body: `🎲 rolled ${n}d${sides}: **${total}**${detail}`,
      };
    }
    case "coin":
    case "flip":
      return {
        handled: true,
        body:
          Math.random() < 0.5 ? "🪙 flipped a coin: **heads**" : "🪙 flipped a coin: **tails**",
      };
    case "8ball":
    case "magic8":
      return {
        handled: true,
        body: `🎱 ${EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)]}`,
      };
    case "shrug":
      return { handled: true, body: (arg ? arg + " " : "") + "¯\\_(ツ)_/¯" };
    case "tableflip":
      return { handled: true, body: (arg ? arg + " " : "") + "(╯°□°)╯︵ ┻━┻" };
    case "unflip":
      return { handled: true, body: (arg ? arg + " " : "") + "┬─┬ ノ( ゜-゜ノ)" };
    case "me":
      // IRC-style emote — italicized self-narration. The leading "*"
      // is a hint to the receiver; we render this client-side too if
      // we ever upgrade Body rendering to handle markdown.
      return { handled: true, body: `*${arg || "does a thing"}*` };
    case "time":
      return {
        handled: true,
        body: `🕒 ${new Date().toLocaleString()}`,
      };
    default:
      return { handled: false, body: input };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

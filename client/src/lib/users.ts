// Helpers for rendering users consistently — display name (with
// fallback) and a deterministic colour for the avatar initials.

import type { UserInfo } from "../types/proto";

// displayNameOf returns user.display_name if set, otherwise
// user.username. Trimmed for safety.
export function displayNameOf(user: UserInfo | undefined | null): string {
  if (!user) return "?";
  const dn = (user.display_name ?? "").trim();
  if (dn) return dn;
  return user.username;
}

// initialsOf returns the first one or two characters used in the
// fallback avatar tile. Prefers the first letter of each word in the
// display name; falls back to the first char of the username.
export function initialsOf(user: UserInfo | undefined | null): string {
  if (!user) return "?";
  const name = displayNameOf(user);
  const parts = name
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .slice(0, 2);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// avatarColorOf maps the user id to one of a fixed palette of pleasant
// background colours for the initials tile. Deterministic per-user so
// the same person always gets the same colour everywhere.
const AVATAR_PALETTE = [
  "#2c5dab",
  "#7a3d8a",
  "#a85a30",
  "#2b8866",
  "#b53d3d",
  "#3d5fb5",
  "#8a3d7a",
  "#5b7a2b",
];

export function avatarColorOf(user: UserInfo | undefined | null): string {
  if (!user) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[user.id % AVATAR_PALETTE.length];
}

// Thin wrappers around the @tauri-apps/api/window calls we use for
// the MSN-style desktop bits — title updates, taskbar flash, focus
// probe. Every call try/catches so the same code works in
// `npm run dev` (a plain browser, no Tauri runtime) as in the
// packaged app.

import {
  getCurrentWindow,
  UserAttentionType,
} from "@tauri-apps/api/window";

// setWindowTitle updates the OS window title — used to prefix the
// total unread count in MSN fashion ("(3) OreoHouse").
export async function setWindowTitle(title: string): Promise<void> {
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    /* not running in Tauri — ignore */
  }
}

// isWindowFocused returns whether the OS window currently has focus.
// Defaults to true on failure so we don't flash in a browser dev
// session.
export async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return true;
  }
}

// flashWindowIfUnfocused asks the OS to flag the window for user
// attention (Windows taskbar flash, macOS dock bounce, GNOME urgent
// hint) — but only when the window isn't already focused, so we
// don't yank attention from someone actively chatting.
export async function flashWindowIfUnfocused(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const focused = await win.isFocused();
    if (focused) return;
    await win.requestUserAttention(UserAttentionType.Informational);
  } catch {
    /* not running in Tauri — ignore */
  }
}

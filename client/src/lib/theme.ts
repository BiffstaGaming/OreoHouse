// Tiny theme system.
//
// We ship three visual styles. The active theme is stored on the
// documentElement as `data-theme="<name>"` and persisted to
// localStorage. App.css contains override blocks keyed on that
// attribute, so flipping the value rewrites every themed surface in
// one operation.
//
// Chat sub-windows live in their own webview, so they read the theme
// from their HydratePayload on open and listen for ThemeChanged
// events from the main window for live switching.

export type ThemeName = "aurora" | "daylight" | "classic";

export const THEMES: { name: ThemeName; label: string; tagline: string }[] = [
  {
    name: "aurora",
    label: "Aurora",
    tagline: "Modern dark — deep navy with a violet accent",
  },
  {
    name: "daylight",
    label: "Daylight",
    tagline: "Modern light — clean off-white with sky-blue",
  },
  {
    name: "classic",
    label: "Classic",
    tagline: "MSN throwback — bevels and blue gradients",
  },
];

export const DEFAULT_THEME: ThemeName = "aurora";

const STORAGE_KEY = "oreohouse-theme";

export function loadTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "aurora" || raw === "daylight" || raw === "classic") {
      return raw;
    }
  } catch {
    // localStorage may be blocked (Tauri rarely, but be defensive).
  }
  return DEFAULT_THEME;
}

export function saveTheme(name: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* see loadTheme */
  }
}

/**
 * Apply the theme attribute to documentElement. Idempotent — repeated
 * calls with the same value are no-ops.
 */
export function applyTheme(name: ThemeName): void {
  if (typeof document === "undefined") return;
  if (document.documentElement.getAttribute("data-theme") !== name) {
    document.documentElement.setAttribute("data-theme", name);
  }
}

// Thin wrapper around @tauri-apps/plugin-updater so the rest of the
// app can ask "is there an update?" without caring whether we're
// running inside Tauri (packaged build) or a plain Vite dev server.
//
// Outside Tauri the wrapper resolves to null — the topbar banner just
// doesn't render. Inside Tauri the wrapper proxies to the plugin and
// surfaces { version, body, install() } so the UI can prompt and
// install when the user clicks.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AvailableUpdate = {
  version: string;
  notes?: string;
  // Calling this downloads the signed artifact, verifies it against
  // the Ed25519 public key baked into tauri.conf.json, installs, and
  // relaunches the app. Throws if download / verification / install
  // fails — caller renders the error.
  install: () => Promise<void>;
};

// checkForUpdate returns the available update or null. Network or
// "not running in Tauri" failures resolve to null silently — there's
// no useful action the user can take, and surfacing them as errors
// would be noise on every browser-dev session.
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  try {
    const update: Update | null = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body,
      install: async () => {
        await update.downloadAndInstall();
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}

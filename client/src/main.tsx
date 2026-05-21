// Entry point. The same Vite bundle powers two top-level views:
//
//   - default: the main contact-list app (`<App />`)
//   - `#/chat/{id}`: a single chat sub-window (`<ChatWindowApp />`)
//
// Each chat sub-window is a separate Tauri window spawned by the main
// window with the URL hash above. Routing is hash-based (no
// react-router dep) — see lib/chatBridge.ts for the IPC contract.

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import ChatWindowApp from "./ChatWindowApp";
import { applyTheme, loadTheme } from "./lib/theme";

// Apply the saved theme before the first paint. Chat sub-windows
// will receive the *current* theme via their Hydrate payload too, but
// painting at load avoids a brief flash of the default look during
// hydration.
applyTheme(loadTheme());

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
const match = window.location.hash.match(/^#\/chat\/(\d+)$/);
if (match) {
  const convID = Number(match[1]);
  root.render(
    <React.StrictMode>
      <ChatWindowApp convID={convID} />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

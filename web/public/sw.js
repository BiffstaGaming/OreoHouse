// OreoHouse service worker.
//
// The PWA needs a registered service worker for browsers (Chrome /
// Android in particular) to offer "Install app" — that's the only
// reason this file exists. We don't actually want to cache the chat
// app offline: messages, attachments, and presence are all
// inherently online. So this worker installs, activates, and gets
// out of the way — no fetch handler means every request goes
// straight to the network as if the SW weren't there.
//
// Bumping the cache name on a redeploy isn't necessary today (no
// cache) but if we ever do precache the shell, change CACHE_VERSION
// so old clients clear their old caches.

const CACHE_VERSION = "v1";

self.addEventListener("install", function (event) {
    // No precache. Skip waiting so a new worker takes over without
    // waiting for every tab to close.
    self.skipWaiting();
});

self.addEventListener("activate", function (event) {
    // Claim every open tab so they all start hitting the new worker
    // (and any future fetch handler) immediately.
    event.waitUntil(self.clients.claim());
});

// Intentionally no fetch handler — see top-of-file comment.

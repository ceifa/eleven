/* eleven's service worker — the one thing that makes the dashboard installable
   and lets it open to something other than a dinosaur when the phone is on a
   lift with no signal.

   The shell is answered from the cache and never waited on. On a phone the
   daemon is a few hundred milliseconds away through a tunnel, and going to the
   network first put four serial round trips in front of the first pixel: the
   page, then the stylesheet and app.js it names, then the modules app.js
   imports, and only then the first read of the API. From the cache all of that
   is zero and the app is on screen while the data is still in flight.

   What network-first bought was freshness: the daemon serves this app straight
   off the checkout, so the html/js/css move under a running page. That is now
   bought after the fact instead of before it — every shell entry is revalidated
   as soon as the app opens, off the critical path and mostly as empty 304s, and
   if the bytes have actually moved the page is told and reloads into them. One
   blink when something changed, instead of a wait on every single start.

   Nothing dynamic is cached. Everything under /api is a live view of a daemon,
   attachments included (/api/media), and none of it belongs in a store that
   outlives the tab. */

const CACHE = "eleven-shell-v3";

// The app shell: what a cold start needs to paint the app with no network at
// all. Fonts are in here too — they are immutable and small, and the wordmark
// falling back to a system serif is the first thing you'd notice.
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/dom.js",
  "/live-turn.js",
  "/markdown.js",
  "/message-display.js",
  "/nav-drag.js",
  "/waveform.js",
  "/style.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/fonts/grenze-600.woff2",
  "/fonts/grenze-700.woff2",
  "/fonts/grenze-800.woff2",
];
const CACHED_PATHS = new Set(SHELL);

self.addEventListener("install", (event) => {
  // One missing file must not fail the whole install — the worker is still
  // worth having for everything that did land.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map(async (path) => {
        try {
          await store(cache, path, await fetch(path));
        } catch { /* not there, or no network yet: the next open fills it in */ }
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The daemon's live surfaces: a stale answer from here would be a lie about
  // what the agent is doing, and /api/media is somebody's private attachments.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // Any address in the SPA renders the same shell, so a navigation is answered
  // with index.html whatever path was asked for. A navigation is also the one
  // moment we know the app is being opened, which is when the copy just served
  // is worth holding against the daemon's.
  if (request.mode === "navigate") {
    event.respondWith(cacheFirst(request, "/index.html"));
    event.waitUntil(revalidateShell());
    return;
  }
  if (CACHED_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Everything else the page may ask for — the other icons, an asset added
  // without touching this list — is still better off current than instant.
  event.respondWith(networkFirst(request));
});

/** The cache, with the network as the answer when it hasn't got one (a first
 *  visit, or a file this worker installed before it existed). */
async function cacheFirst(request, fallback) {
  const cached = await fromCache(request, fallback);
  return cached ?? networkFirst(request, fallback);
}

/** The network, with the cache as the answer when there isn't one. A successful
 *  same-origin response is put back so the next cold start has it. */
async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request);
    // Only full, first-party 200s: a 404 or an opaque response cached here
    // would be served as the app for as long as the worker lives.
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => store(cache, request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await fromCache(request, fallback);
    if (cached) return cached;
    throw error;
  }
}

/** Put a response in the cache without the two headers that describe a
 *  compression it no longer has. `fetch` in a worker hands over a body that is
 *  already decoded, while `content-encoding: br` and the compressed
 *  `content-length` stay behind in the header list — 19 kB of stylesheet
 *  claiming to be 5 kB of brotli. Chromium ignores both when it replays the
 *  entry; a browser that took them at their word would try to decompress plain
 *  text, and the app would fail to open from the cache with nothing on screen
 *  to say why. */
async function store(cache, key, response) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const body = await response.blob();
  return cache.put(key, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

/* ignoreVary: the assets are stored under one encoding-varying key each, and
   the only thing that ever asks for them is this same browser. A request whose
   Accept-Encoding drifted from the one that filled the cache (a Chrome update
   adding zstd, say) would otherwise miss and be served the slow way for good. */
const fromCache = async (request, fallback) =>
  (await caches.match(request, { ignoreVary: true }))
  ?? (fallback ? await caches.match(fallback, { ignoreVary: true }) : undefined);

/** What the daemon says this file currently is. ETags here are a hash of the
 *  bytes, so they compare across encodings and across restarts. */
const version = (response) => response.headers.get("etag") ?? response.headers.get("last-modified") ?? "";

/** Hold every shell entry against the daemon and take whatever has moved. The
 *  shell carries `cache-control: no-cache`, so these are conditional requests
 *  that come back as empty 304s while nothing has changed — a handful of them,
 *  after the page is already up.
 *
 *  When something *has* changed, the page that is running is older than the API
 *  it talks to, and the next render can throw on a field that was renamed under
 *  it. So the clients are told, and they reload into the bytes just stored. */
let checking;
function revalidateShell() {
  checking ??= (async () => {
    const cache = await caches.open(CACHE);
    let moved = false;
    await Promise.all(SHELL.map(async (path) => {
      let response;
      try {
        response = await fetch(path);
      } catch {
        return; // offline: the cache is the only copy there is, and it stays
      }
      if (!response.ok || response.type !== "basic") return;
      const previous = await cache.match(path, { ignoreVary: true });
      // No previous copy is not a change — it is a file this worker never had.
      const changed = previous && version(previous) !== version(response);
      await store(cache, path, response).catch(() => {});
      if (changed) moved = true;
    }));
    if (!moved) return;
    for (const client of await self.clients.matchAll({ type: "window" })) {
      client.postMessage({ type: "shell-updated" });
    }
  })().finally(() => { checking = undefined; });
  return checking;
}

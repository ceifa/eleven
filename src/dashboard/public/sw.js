/* eleven's service worker — the one thing that makes the dashboard installable
   and lets it open to something other than a dinosaur when the phone is on a
   lift with no signal.

   It is deliberately conservative. The daemon serves this app straight off the
   checkout: the html/js/css change under a running page, which is why the
   socket announces a shell version and the page reloads itself when it moves.
   A cache-first shell would answer exactly that reload with the bytes it is
   trying to leave behind — so every request goes to the network first and the
   cache is only ever the offline answer. Online, that costs nothing extra: the
   assets carry ETags and revalidate as empty 304s, same as without a worker.

   Nothing dynamic is cached. Everything under /api is a live view of a daemon,
   attachments included (/api/media), and none of it belongs in a store that
   outlives the tab. */

const CACHE = "eleven-shell-v1";

// The app shell: what a cold, offline start needs to paint something. Fonts are
// in here too — they are immutable and small, and the wordmark falling back to
// a system serif is the first thing you'd notice.
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/dom.js",
  "/live-turn.js",
  "/markdown.js",
  "/message-display.js",
  "/waveform.js",
  "/style.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/fonts/grenze-600.woff2",
  "/fonts/grenze-700.woff2",
  "/fonts/grenze-800.woff2",
];

self.addEventListener("install", (event) => {
  // One missing file must not fail the whole install — the worker is still
  // worth having for everything that did land.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {}))))
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

  // Any address in the SPA renders the same shell, so an offline navigation is
  // answered with the cached index.html whatever path was asked for.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/index.html"));
    return;
  }
  event.respondWith(networkFirst(request));
});

/** The network, with the cache as the answer when there isn't one. A successful
 *  same-origin response is put back so the next cold start has it. */
async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request);
    // Only full, first-party 200s: a 404 or an opaque response cached here
    // would be served as the app for as long as the worker lives.
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = (await caches.match(request)) ?? (fallback ? await caches.match(fallback) : undefined);
    if (cached) return cached;
    throw error;
  }
}

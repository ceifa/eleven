/* The daemon's HTTP API as the page reaches it: the one fetch every request
   goes through, the sign-in trip an auth proxy can ask for, the boot's
   prefetches, and the small cache over the reads every view repeats. */

// The daemon never redirects, so a redirect here is an auth proxy in front of it
// (Cloudflare Access and the like) whose session ran out. Followed, it lands
// cross-origin on a sign-in page and fails exactly like a daemon that is down.
const call = (path, init) => fetch(`/api${path}`, { ...init, redirect: "manual" });

const api = {
  get: (path) => take(path) ?? call(path).then(ok),
  send: (method, path, body) =>
    call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(ok),
};
class SignInExpired extends Error {}
async function ok(response) {
  if (response.type === "opaqueredirect") {
    signIn();
    throw new SignInExpired("sign-in expired");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data;
}

/** The shell came out of the service worker's cache, so the proxy never got a
 *  navigation to send to its sign-in. /api/signin is one the worker lets
 *  through and the daemon bounces back to the app. At most once a minute
 *  unless asked: a proxy still redirecting after a sign-in would otherwise
 *  reload the page forever. */
const SIGNIN_RETRY_MS = 60_000;
function signIn({ force = false } = {}) {
  const last = Number(sessionStorage.getItem("eleven.signin-at"));
  if (!force && Date.now() - last < SIGNIN_RETRY_MS) return;
  sessionStorage.setItem("eleven.signin-at", String(Date.now()));
  location.assign(`/api/signin${location.hash}`);
}

/** Reads that were already in flight before anyone asked for them — see the
 *  boot at the bottom of app.js. Each is taken by the first `api.get` for
 *  its path and gone after that, so nothing is ever answered from a promise old
 *  enough to be stale. */
const started = new Map();
function take(path) {
  const value = started.get(path);
  if (value) started.delete(path);
  return value;
}
function prefetch(path) {
  const value = api.get(path);
  // It is answered by whoever asks for the path. The empty catch only keeps a
  // failure in the meantime from being reported as an unhandled rejection —
  // the promise the caller gets still rejects, and is still handled there.
  value.catch(() => {});
  started.set(path, value);
}

// Reads that describe the daemon rather than the conversation — /overview and
// /config — answer the same thing until something changes them, and every view
// wants them. Fetching both on every navigation spent two round trips redrawing
// what the page already held, so they're kept here instead and the daemon's own
// events (a config save, a pairing request) throw them away. The TTL is only a
// backstop for what no event announces, like a bot dropping offline.
const CACHE_TTL_MS = 30_000;
const reads = new Map();

function cachedGet(path, { force = false } = {}) {
  const hit = reads.get(path);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  // The promise is what's cached, so overlapping callers share one round trip.
  const value = api.get(path).catch((error) => {
    reads.delete(path);
    throw error;
  });
  reads.set(path, { at: Date.now(), value });
  return value;
}

/** Remember a value we already know is current (a PUT's own response). */
const seedCache = (path, value) => reads.set(path, { at: Date.now(), value });
const invalidate = (...paths) => { for (const path of paths) reads.delete(path); };

export { call, api, SignInExpired, ok, signIn, started, prefetch, cachedGet, seedCache, invalidate };

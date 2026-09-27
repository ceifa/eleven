/* What the page last knew, kept on the device, so a cold start paints the
   thread list — and a conversation read lately — before the daemon has
   answered anything. From a phone the daemon is a tunnel away, and every
   screen used to open on a round trip; a messenger opens on what it already
   has and lets the network correct it.

   This is a copy of private conversations on the device, which the service
   worker deliberately never makes of /api. The trade is taken here, narrowly:
   the last default thread list, the overview, and the recent transcripts the
   page already holds in memory — never media, never a search, never what a
   turn was doing. It is only ever painted as a first frame; the daemon's own
   answer replaces it the moment it lands. */

const DB_NAME = "eleven";
const STORE = "snapshot";
/** A store that takes longer than this to open is slower than the network it
 *  is meant to beat: the page boots without it. */
const OPEN_TIMEOUT_MS = 250;
const WRITE_DELAY_MS = 800;

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("snapshot store blocked"));
  });
  return dbPromise;
}

/** Everything kept, as `{ key: value }` — or `{}` when there is no store, it
 *  is empty, or it could not be read in time. Never rejects. */
export async function readSnapshot() {
  if (!globalThis.indexedDB) return {};
  const read = db().then((database) => new Promise((resolve, reject) => {
    const out = {};
    const cursor = database.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return resolve(out);
      out[at.key] = at.value;
      at.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  }));
  const late = new Promise((resolve) => setTimeout(() => resolve({}), OPEN_TIMEOUT_MS));
  return Promise.race([read, late]).catch(() => ({}));
}

/** Keep `value` under `key`. Coalesced: the list is re-read on every event,
 *  and writing a few hundred kilobytes each time would be work for nothing. */
const pending = new Map();
let timer;
export function keep(key, value) {
  if (!globalThis.indexedDB) return;
  pending.set(key, value);
  clearTimeout(timer);
  timer = setTimeout(flush, WRITE_DELAY_MS);
}

function flush() {
  const writes = [...pending];
  pending.clear();
  db().then((database) => {
    const store = database.transaction(STORE, "readwrite").objectStore(STORE);
    for (const [key, value] of writes) value === undefined ? store.delete(key) : store.put(value, key);
  }).catch(() => {});
}
// A page being put away is the last chance to write what it learned.
addEventListener("pagehide", () => { if (pending.size) flush(); });

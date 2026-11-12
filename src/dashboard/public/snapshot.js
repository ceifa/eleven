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
   answer replaces it the moment it lands.

   One key per thing kept, a transcript included: a conversation is hundreds of
   kilobytes, and sixteen of them under one key were all copied into the store
   every time one was read, and all copied back out before the first frame. */

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

const settled = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const reading = () => db().then((database) => database.transaction(STORE, "readonly").objectStore(STORE));

/** What is kept under `keys`, as `{ key: value }` without the ones that hold
 *  nothing — or `{}` when there is no store, or it could not be read in time.
 *  Never rejects. This is the read a cold start waits on, so it is asked for
 *  exactly what the first frame paints. */
export async function readSnapshot(keys) {
  if (!globalThis.indexedDB) return {};
  const read = reading().then(async (store) => {
    const values = await Promise.all(keys.map((key) => settled(store.get(key))));
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]).filter(([, value]) => value !== undefined));
  });
  const late = new Promise((resolve) => setTimeout(() => resolve({}), OPEN_TIMEOUT_MS));
  return Promise.race([read, late]).catch(() => ({}));
}

/** Every value kept under a key that starts with `prefix` — the rest of what
 *  the page knew, for after the first frame. Never rejects. Walked with a
 *  cursor rather than asked for at once: each value is copied out of the store
 *  on the main thread, and one at a time that is sixteen short tasks a tap can
 *  land between instead of one long one it has to wait behind. */
export async function readSnapshotUnder(prefix) {
  if (!globalThis.indexedDB) return [];
  return reading().then((store) => new Promise((resolve, reject) => {
    const values = [];
    const walk = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    walk.onsuccess = () => {
      const at = walk.result;
      if (!at) return resolve(values);
      values.push(at.value);
      at.continue();
    };
    walk.onerror = () => reject(walk.error);
  })).catch(() => []);
}

/** Keep `value` under `key`, or nothing under it when `value` is undefined.
 *  Coalesced: the list is re-read on every event, and writing a few hundred
 *  kilobytes each time would be work for nothing. */
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

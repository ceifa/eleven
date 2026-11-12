/* What the page holds: the view's root, the state every module renders from,
   and the two stores that outlive a reload (prefs, drafts). It imports nothing,
   so anything may import it. */

const view = document.getElementById("view");
const state = {
  threads: [],
  activeThread: null,
  /** Durable transcript rows as the session file has them, oldest first. */
  timeline: [],
  requests: [],
  /** The running turn's activity in order: prose, tool calls, provider
   *  requests, and messages that arrived while it was running. */
  live: [],
  /** When the running turn began (0 when none is). Also the cut-off that says
   *  which durable rows the live region owns. */
  liveStartedAt: 0,
  /** Bumped whenever the running turn's live record is invalidated (a turn
   *  started, or failed over), so an in-flight fetch can tell its snapshot is
   *  already old. */
  liveEpoch: 0,
  /** When a delta last arrived, anywhere — so the status can tell prose that is
   *  still streaming from prose that stopped a minute ago. */
  lastDeltaAt: 0,
  /** The panels the running turn's producers publish. State, not a log: the
   *  daemon sends all of them on every change, so this is replaced rather than
   *  appended to — and a page opened mid-turn gets the same from the catch-up. */
  panels: [],
  /** Messages that exist but haven't landed in the transcript yet — just sent
   *  from here, or just arrived from a channel, with no turn running to hold
   *  them. */
  pending: [],
  workspaceFilter: "",
  /** Free-text search over titles, conversations and transcripts. */
  query: "",
  /** Channel type ("telegram", "dashboard", …), "" for all. */
  filterSource: "",
  /** Channel types seen this session — what the channel filter offers. */
  sources: new Set(),
  overview: null,
  config: null,
  catalog: null,
  /** Provider-request chips in the transcript. Off by default: they are
   *  debugging detail, and interleaved with every message they were the loudest
   *  thing on a page whose subject is the conversation. */
  showRequests: false,
};

/** Small UI preferences that should survive a reload (they describe how this
 *  browser likes to read, not anything the daemon owns). */
const prefs = {
  get: (key, fallback) => {
    try { return localStorage.getItem(`eleven.${key}`) ?? fallback; } catch { return fallback; }
  },
  set: (key, value) => {
    try { localStorage.setItem(`eleven.${key}`, value); } catch { /* private mode */ }
  },
  remove: (key) => {
    try { localStorage.removeItem(`eleven.${key}`); } catch { /* private mode */ }
  },
};
state.showRequests = prefs.get("requests", "0") === "1";

/** What was typed into a composer and not sent yet. A half-written message is
 *  work, and the pane is torn down by things its writer never asked for —
 *  opening another thread, a route change, a reload — so it's kept per thread
 *  and outside the DOM. Empty means no draft: nothing is left behind for a
 *  thread that was typed in and then cleared. */
const drafts = {
  get: (id) => prefs.get(`draft.${id}`, ""),
  set: (id, text) => (text ? prefs.set(`draft.${id}`, text) : drafts.clear(id)),
  clear: (id) => prefs.remove(`draft.${id}`),
};
const NEW_THREAD_DRAFT = "new"; // the launcher's box has no thread to key on yet

export { view, state, prefs, drafts, NEW_THREAD_DRAFT };

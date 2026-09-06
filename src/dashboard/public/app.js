/* eleven dashboard — vanilla SPA, hand-written CSS, no build step. */

import { syncChildren } from "./dom.js";
import { agentDetail, agentMeta, displayId, elapsed, hasTasks, liveStatus, MATCH_CHARS, startOfDay, taskIcon, transcriptRows } from "./live-turn.js";
import { md } from "./markdown.js";
import { navDrag } from "./nav-drag.js";
import { presentMessage, sameMessage } from "./message-display.js";
import { connectWaveform, WAVEFORM_BAR_COUNT } from "./waveform.js";

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
  /** The running turn's plan and subagents. State, not a log: the daemon sends
   *  the whole board on every change, so this is replaced rather than appended
   *  to — and a page opened mid-turn gets the same shape from the catch-up. */
  tasks: { plan: [], agents: [], agentTotal: 0 },
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

/* ---------- helpers ---------- */

const api = {
  get: (path) => fetch(`/api${path}`).then(ok),
  send: (method, path, body) =>
    fetch(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(ok),
};
async function ok(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data;
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

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "html") el.innerHTML = value;
    else if (value !== undefined && value !== false) el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return el;
}

function toast(message, isError = false) {
  const el = h("div", { class: `alert ${isError ? "alert-error" : "alert-success"}`, role: "status" }, h("span", {}, message));
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), 3500);
}

const TELEGRAM_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Telegram"><circle cx="12" cy="12" r="12" fill="#54A9EB"/><path fill="#fff" d="M17.6 7.2 15.7 16.4c-.14.63-.52.78-1.05.49l-2.9-2.14-1.4 1.35c-.16.16-.29.29-.59.29l.21-2.95 5.37-4.85c.23-.2-.05-.32-.36-.11l-6.64 4.18-2.86-.9c-.62-.2-.63-.62.13-.92l11.18-4.31c.52-.19.97.13.8.87z"/></svg>`;
// Local origins get a glyph too — not for decoration: it keeps every name in
// the list starting at the same x, however the thread was born.
const DASHBOARD_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Dashboard" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18"/></svg>`;
const CLI_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="CLI" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 2.4 2.3-2.4 2.3M13 14.6h3.6"/></svg>`;
const CHANNEL_ICONS = { telegram: TELEGRAM_ICON, dashboard: DASHBOARD_ICON, cli: CLI_ICON };

const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="m10.3 10.3 3.2 3.2"/></svg>`;
const PLUS_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>`;
const FILTER_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/></svg>`;
const SEND_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13.2V3.4M4 7.2 8 3.2l4 4"/></svg>`;
const ARROW_DOWN_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2v9.4M4.2 8.8 8 12.6l3.8-3.8"/></svg>`;
const CLIP_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.8 7.3 6.6 11.5a2 2 0 0 1-2.9-2.8l5-5a3.1 3.1 0 0 1 4.4 4.4l-5 5a4.2 4.2 0 0 1-6-6l4.3-4.3"/></svg>`;
const MIC_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3.4 8.4 3.1 3.1 6.1-6.9"/></svg>`;
const X_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/></svg>`;

// A thread's origin — the sessionKey's prefix is the channel type
// (telegram:…, dashboard:…). The glyph sits next to the conversation name, so
// a type we have no icon for renders nothing: the name already says "Dashboard"
// or "CLI", and a bare word there would only stutter it.
/** The conversation label without the channel type it opens with — the glyph
 *  next to it already says "telegram", and the word after it only stutters. */
function withoutChannelPrefix(label, sessionKey) {
  const type = sessionKey.split(":")[0];
  if (!CHANNEL_ICONS[type]) return label;
  const [first, ...rest] = label.split(" · ");
  // "Telegram DM · Gabriel" loses its first segment; a bare "Dashboard" keeps
  // it, because there it is the whole name.
  return rest.length && first.toLowerCase().startsWith(type) ? rest.join(" · ") : label;
}

function channelSource(sessionKey) {
  const type = sessionKey.split(":")[0];
  const icon = CHANNEL_ICONS[type];
  return icon ? h("span", { class: "channel-glyph", title: type, html: icon }) : null;
}

const timeAgo = (ts) => {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const DAY_MS = 86_400_000;

/** "Today" / "Yesterday" / a date — the label on a transcript's day separator. */
function dayLabel(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Is the scroll container within a hair of the bottom? Used to decide whether
// live updates should follow along or leave the reader where they scrolled to.
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;

// Play a one-shot animation class, replaying from the top if it's mid-flight
// (class drop + forced reflow), and clear the class when the animation ends.
// getBoundingClientRect, not offsetWidth: the bulbs are SVG circles, and
// offsetWidth is HTML-only (undefined on SVG — it wouldn't flush layout).
function flare(el, cls) {
  if (el.classList.contains(cls)) {
    el.classList.remove(cls);
    el.getBoundingClientRect();
  }
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

/* ---------- live updates ---------- */

let liveTimer;
// The app shell this page is running, as the server stamped it on the first
// socket. A daemon restart drops the socket, and the reconnect brings the
// current stamp — if it moved, the code in this tab is older than the API it
// talks to and the next render throws on a field that was renamed under it.
// Reload rather than limp along.
let shellVersion;
function connectWs() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}/ws`);
  const dot = document.getElementById("ws-dot");
  const label = document.getElementById("ws-label");
  // The server pings every 20s; a silent socket is half-open (daemon restarted) — force a reconnect.
  let silence;
  const alive = () => {
    clearTimeout(silence);
    silence = setTimeout(() => ws.close(), 50_000);
  };
  ws.onopen = () => ((dot.className = "status status-success"), (label.textContent = "live"), alive());
  ws.onclose = () => {
    clearTimeout(silence);
    dot.className = "status status-error";
    label.textContent = "reconnecting";
    setTimeout(connectWs, 2000);
  };
  ws.onmessage = (event) => {
    alive();
    const message = JSON.parse(event.data);
    if (message.type === "ping") return;
    if (message.type === "hello") {
      if (shellVersion !== undefined && message.shell !== shellVersion) return location.reload();
      shellVersion = message.shell;
      return;
    }
    pulse();
    stripFlash();
    const active = message.threadId && message.threadId === state.activeThread?.id;
    // A turn began (or failed over and restarted): the live region belongs to
    // the new attempt, so drop whatever the old one left there. Anything durable
    // it produced is already on disk and comes back with the transcript.
    if (message.type === "turn-start" || message.type === "turn-rewound") {
      markThreadLive(message.threadId);
      if (active) {
        liveEpoch++;
        state.live = [];
        state.liveStartedAt = Date.now();
        state.tasks = { plan: [], agents: [], agentTotal: 0 };
        renderLive(true);
        renderTasks();
      }
    }
    if (message.type === "delta") {
      markThreadLive(message.threadId);
      lastDeltaAt = Date.now();
      if (active) {
        // Prose that follows a tool call starts its own bubble — same shape the
        // transcript has after a reload.
        const last = state.live.at(-1);
        if (last?.kind === "text") last.text += message.delta;
        else state.live.push({ kind: "text", text: message.delta });
        scheduleLiveRender();
      }
    }
    if (message.type === "provider-request") {
      markThreadLive(message.threadId);
      if (active) {
        state.live.push({ kind: "request", id: message.id, model: message.model, at: Date.now() });
        renderLive();
      }
    }
    if (message.type === "tool-call") {
      markThreadLive(message.threadId);
      // The event carries the durable call id and the full args, so the row is
      // clickable right away — no reload needed to inspect a call mid-turn.
      if (active) {
        state.live.push({ kind: "tool", id: message.id, name: message.name, summary: message.summary ?? "", args: message.args });
        renderLive();
      }
    }
    if (message.type === "task-activity") {
      markThreadLive(message.threadId);
      // The whole board arrives folded — store it, don't reduce it.
      if (active) {
        state.tasks = message.tasks ?? { plan: [], agents: [], agentTotal: 0 };
        renderTasks();
      }
    }
    if (message.type === "turn-done" || message.type === "turn-error") {
      markThreadIdle(message.threadId);
      if (active) state.liveStartedAt = 0;
      if (message.type === "turn-error") {
        toast(message.error, true);
        stripError();
      }
      if (active) openThread(message.threadId);
      refreshThreads();
    }
    if (message.type === "thread-deleted") {
      markThreadIdle(message.threadId);
      if (active) {
        state.activeThread = null;
        renderThreadPane();
        closePaneMobile();
      }
      refreshThreads();
    }
    if (message.type === "thread-started") {
      // A conversation rotated (here, from Telegram, or in another tab): the
      // thread this page shows as current isn't anymore.
      refreshThreads();
    }
    if (message.type === "activity") {
      // Show the message now instead of at the end of the turn: a Telegram
      // message (or a reply eleven sent on its own) is real the moment the
      // daemon reports it, and the next transcript read reconciles it.
      if (active && message.text) {
        const role = message.direction === "in" ? "user" : "assistant";
        // A message that lands mid-turn is steered into that turn — so it goes
        // into the live record, where it happened, instead of into the pending
        // region that sits above everything the turn has streamed so far.
        if (role === "user" && state.liveStartedAt) pushLiveMessage({ role, text: message.text });
        // A reply from the running turn is already on screen as streamed prose;
        // only one eleven sent outside a turn (the operator "send") needs a bubble.
        else if (role === "user" || !state.live.some((item) => item.kind === "text")) showPending(role, message.text);
        scheduleReconcile();
      }
      scheduleThreadRefresh(message.workspace);
    }
    if (message.type === "config-changed") {
      invalidate("/config", "/overview");
      onConfigChanged();
    }
    if (message.type === "pairing") {
      invalidate("/overview");
      toast(`pairing request: ${message.request.chatTitle ?? message.request.name ?? message.request.userId}`);
      // render() refetches /overview and repaints the badge itself — don't double-fetch.
      location.hash.startsWith("#/workspaces") ? render() : updatePairingBadge();
    }
  };
}

// Both signs (sidebar + mobile top bar) glow together. They're static in the
// markup, so query once rather than re-scanning the DOM on every WS message.
const WORDMARKS = document.querySelectorAll(".wordmark");

/** The signature: the wordmark burns brighter while any turn is streaming. */
function pulse() {
  for (const wordmark of WORDMARKS) {
    // A turn just began (the sign was dark): stutter it to life before the steady glow.
    if (!wordmark.classList.contains("live")) flare(wordmark, "flicker");
    wordmark.classList.add("live");
  }
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => WORDMARKS.forEach((w) => w.classList.remove("live")), 2500);
}

/* ---------- string lights (the wall) ---------- */

// Bulb colors live in style.css (nth-of-type rules on --bulb) so a future
// theme block can repaint the wall; JS only does the geometry.
const BULB_COUNT = 8;
const bulbs = []; // filled by initStringLights, then reused on every flash

/** Place the bulbs along the sidebar wire (index.html only ships the path). */
function initStringLights() {
  const svg = document.getElementById("string-lights");
  const wire = svg?.querySelector(".wire");
  const length = wire?.getTotalLength();
  if (!length) return;
  for (let i = 0; i < BULB_COUNT; i++) {
    const point = wire.getPointAtLength(((i + 0.5) / BULB_COUNT) * length);
    const bulb = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bulb.setAttribute("cx", point.x);
    bulb.setAttribute("cy", point.y);
    bulb.setAttribute("r", "2.6");
    bulb.setAttribute("class", "bulb");
    bulb.style.setProperty("--twinkle", `${i * -0.65}s`); // negative: start mid-phase
    bulbs.push(bulb);
    svg.append(bulb);
  }
}

// Every live event flares the next bulb along the string, so a fast delta
// stream visibly chases light across the wire.
let bulbCursor = 0;
function stripFlash() {
  if (bulbs.length) flare(bulbs[bulbCursor++ % bulbs.length], "lit");
}

/** turn-error: every light on the wall flares red at once. */
function stripError() {
  for (const bulb of bulbs) {
    bulb.classList.remove("lit"); // the red sweep replaces any running flare
    flare(bulb, "err");
  }
}

// Which threads have a turn running right now — the breathing amber halo on the
// list cards, and whether the open thread offers a stop button. Two sources,
// and both are needed:
//   · the server's `running` flag, which rides along with every thread list. It
//     is the only thing a page opened (or reloaded) mid-turn can learn from —
//     WS events only reach pages that were already connected.
//   · the live events, which light a thread the instant it speaks, without
//     waiting for a list read.
// The event half carries a safety timer, so a thread whose end event we miss
// (a dropped socket) doesn't stay lit forever; each new event refreshes it.
// turn-done/turn-error clear both halves at once.
const threadLiveTimers = new Map();
const serverRunning = new Set();
// When each thread last went idle. A read of /threads issued before a turn
// ended can land after it, carrying a snapshot that still says "running" — this
// is what keeps such an answer from relighting a thread we already know is done
// (and from bringing its stop button back for another twelve seconds).
const wentIdleAt = new Map();
const isThreadLive = (threadId) => threadLiveTimers.has(threadId) || serverRunning.has(threadId);

function markThreadLive(threadId) {
  if (!threadId) return;
  const wasLive = isThreadLive(threadId);
  wentIdleAt.delete(threadId);
  clearTimeout(threadLiveTimers.get(threadId));
  threadLiveTimers.set(threadId, setTimeout(() => markThreadIdle(threadId), 12_000));
  if (!wasLive) applyThreadLive(threadId); // already-lit card: skip the DOM query per delta
}
function markThreadIdle(threadId) {
  if (!threadId) return;
  wentIdleAt.set(threadId, Date.now());
  if (!isThreadLive(threadId)) return;
  clearTimeout(threadLiveTimers.get(threadId));
  threadLiveTimers.delete(threadId);
  serverRunning.delete(threadId);
  applyThreadLive(threadId);
}
function setServerRunning(threadId, running) {
  const wasLive = isThreadLive(threadId);
  running ? serverRunning.add(threadId) : serverRunning.delete(threadId);
  if (wasLive !== isThreadLive(threadId)) applyThreadLive(threadId);
}
/** Adopt the server's view of what is running, from a list read issued at
 *  `readAt` — anything we learned after that read left is newer, and wins. */
function seedRunning(threads, readAt) {
  const running = new Set(threads.filter((thread) => thread.running).map((thread) => thread.id));
  for (const id of serverRunning) if (!running.has(id)) setServerRunning(id, false);
  for (const id of running) if ((wentIdleAt.get(id) ?? 0) < readAt) setServerRunning(id, true);
}
// Toggle the class on the card directly so a burst of deltas doesn't re-render
// the whole list; renderThreadList re-applies the state on any full rebuild.
function applyThreadLive(threadId) {
  const live = isThreadLive(threadId);
  const card = document.querySelector(`#thread-list [data-thread-id="${threadId}"]`);
  if (card) card.classList.toggle("is-live", live);
  // The open thread wears the same truth: the header's running pill, the
  // "working" dots, and the composer's send button becoming a stop button all
  // hang off this one class, so none of them needs the pane re-rendered.
  if (threadId === state.activeThread?.id) {
    document.getElementById("thread-pane")?.classList.toggle("is-running", live);
    if (live) updateLiveStatus();
  }
}

// Paint the sidebar badge from whatever overview we already have in state.
function applyPairingBadge() {
  const badge = document.getElementById("pairing-badge");
  const count = state.overview?.pairing?.length ?? 0;
  badge.hidden = count === 0;
  badge.textContent = count;
}
// Fetch a fresh overview, then repaint the badge (used when only the badge,
// not the whole view, needs to react — e.g. an incoming pairing request).
async function updatePairingBadge() {
  const overview = await cachedGet("/overview").catch(() => null);
  if (overview) state.overview = overview;
  applyPairingBadge();
}

/* ---------- threads view ---------- */

const onThreadsView = () => location.hash.startsWith("#/threads") || location.hash === "" || location.hash === "#/";

/** Every narrowing the list is showing, as the API's own query string — the
 *  server filters and searches, so a filtered view costs a smaller response
 *  rather than a full one the browser throws most of away. */
function threadsQuery() {
  const params = new URLSearchParams();
  if (state.workspaceFilter) params.set("workspace", state.workspaceFilter);
  if (state.filterSource) params.set("channel", state.filterSource);
  if (state.query) params.set("q", state.query);
  const query = params.toString();
  return query ? `?${query}` : "";
}

// Reads can overlap (a keystroke, a turn ending, an arriving message) and they
// don't come back in order — an older answer landing last would paint a list
// the filters no longer describe, and reinstate "running" for a turn that has
// since ended. Only the newest read is allowed to touch state.
let threadsSeq = 0;
async function refreshThreads() {
  const seq = ++threadsSeq;
  const readAt = Date.now();
  const threads = await api.get(`/threads${threadsQuery()}`).catch((error) => (toast(error.message, true), null));
  if (!threads || seq !== threadsSeq) return;
  state.threads = threads;
  for (const thread of threads) state.sources.add(thread.source);
  seedRunning(threads, readAt);
  if (onThreadsView()) renderThreadList();
}

// `activity` fires for every thread in every workspace. Only refetch when it
// touches the list we're actually showing, and coalesce bursts into one call.
let threadRefreshTimer;
function scheduleThreadRefresh(workspace) {
  if (!onThreadsView()) return;
  if (state.workspaceFilter && workspace && workspace !== state.workspaceFilter) return;
  clearTimeout(threadRefreshTimer);
  threadRefreshTimer = setTimeout(refreshThreads, 250);
}

async function onConfigChanged() {
  // A local save echoes back as config-changed; don't rebuild the view mid-edit.
  if (savesInFlight > 0) return;
  // Every view but the threads one renders from config.
  if (onThreadsView()) return;
  const fresh = await cachedGet("/config").catch(() => null);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.config)) render();
}

/** Wrap the query's occurrences in <mark>. Plain case-insensitive matching, not
 *  the accent-folding the server searches with: folding changes lengths, so its
 *  offsets don't map back onto the text being displayed. A snippet the server
 *  found through an accent simply shows unhighlighted instead of highlighting
 *  the wrong span. */
function highlight(text, query) {
  if (!query) return [text];
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return parts.map((part, index) => (index % 2 ? h("mark", {}, part) : part));
}

/* The list is rebuilt on every event that could have touched it — a message
   arriving, a turn ending, a filter changing — and there are hundreds of cards.
   Building them all again to move one row means thousands of DOM nodes for a
   change you can point at, so a card is kept and reused until the data it
   renders actually changes, and the column is reconciled by moving the nodes
   that are already there. */
const cardCache = new Map(); // thread id → { node, signature }
const toggleCache = new Map(); // sessionKey → { node, signature }

/** Everything the card paints, so an unchanged reading reuses its node. Live
 *  and active state are deliberately absent: they are classes toggled on the
 *  node, and rebuilding the card for them would restart the halo animation. */
const cardSignature = (thread, older) =>
  JSON.stringify([
    older, thread.sessionKey, thread.conversationName, thread.conversation,
    thread.title, thread.workspace, thread.lastActivityAt, thread.matches ?? null, state.query,
  ]);

function threadCard(thread, older = false) {
  const signature = cardSignature(thread, older);
  const cached = cardCache.get(thread.id);
  let node;
  if (cached?.signature === signature) {
    node = cached.node;
    // The one thing that drifts on a node nobody rebuilt: "5m" becomes "6m"
    // whether or not the thread said anything.
    const label = node.querySelector("[data-since]");
    const since = timeAgo(thread.lastActivityAt);
    if (label && label.textContent !== since) label.textContent = since;
  } else {
    node = buildThreadCard(thread, older);
    cardCache.set(thread.id, { node, signature });
  }
  node.classList.toggle("is-active", thread.id === state.activeThread?.id);
  node.classList.toggle("is-live", isThreadLive(thread.id));
  return node;
}

function buildThreadCard(thread, older) {
  return h(
    "button",
    {
      "data-thread-id": thread.id,
      class: `card card-sm w-full bg-base-200 ${older ? "is-older" : ""}`,
      // The full reading (channel · group · topic) is one hover away; the card
      // itself only has room for the part that identifies it.
      title: thread.conversation,
      onclick: () => { openThread(thread.id); openPaneMobile(thread.id); },
    },
    h("div", { class: "card-body py-3 px-4" },
      // What you recognize a thread by: the forum topic, the group, or the
      // person in the DM — not the first 80 characters they happened to type.
      h("div", { class: "flex items-center gap-2 text-sm" },
        channelSource(thread.sessionKey),
        h("span", { class: "truncate min-w-0" }, thread.conversationName ?? thread.sessionKey),
        // Always in the markup, shown by CSS only on a live card: the halo says
        // "something is happening here" from the corner of your eye, and this
        // says it plainly. Painting it as a class keeps the card cacheable.
        h("i", { class: "spinner card-spinner", "aria-hidden": "true" }),
        h("span", { class: "ml-auto shrink-0 text-xs thread-meta font-mono", "data-since": thread.lastActivityAt }, timeAgo(thread.lastActivityAt)),
      ),
      h("div", { class: "flex items-center gap-2 text-xs thread-meta font-mono" },
        h("span", { class: "text-warning shrink-0" }, thread.workspace),
        h("span", { class: "truncate min-w-0" }, thread.title ?? "(untitled)"),
      ),
      // Why this thread is in the results: what was said, where it was said.
      ...(thread.matches ?? []).map((match) =>
        h("div", { class: "thread-match text-xs" },
          h("span", { class: "thread-match-role font-mono" }, match.role === "user" ? "you" : "agent"),
          h("span", {}, highlight(match.snippet, state.query)),
        ),
      ),
    ),
  );
}

/** One row per conversation. A conversation outlives its threads — /new and the
 *  idle window both rotate a fresh one — so the newest generation leads and the
 *  older ones fold underneath instead of filling the list with cards that all
 *  say the same topic.
 *
 *  Search results are not grouped: every row there is a hit the query earned,
 *  and folding one under another would hide the answer someone asked for. */
function groupThreads(threads) {
  if (state.query) return threads.map((thread) => [thread]);
  const groups = new Map();
  for (const thread of threads) {
    const group = groups.get(thread.sessionKey);
    if (group) group.push(thread);
    else groups.set(thread.sessionKey, [thread]);
  }
  return [...groups.values()];
}

const expandedGroups = new Set();
function toggleGroup(sessionKey) {
  if (!expandedGroups.delete(sessionKey)) expandedGroups.add(sessionKey);
  renderThreadList();
}

function olderToggle(sessionKey, count, open) {
  const signature = `${count}:${open}`;
  const cached = toggleCache.get(sessionKey);
  if (cached?.signature === signature) return cached.node;
  const node = h("button", { class: "older-toggle text-xs font-mono", onclick: () => toggleGroup(sessionKey) },
    `${open ? "▾" : "▸"} ${count} older`);
  toggleCache.set(sessionKey, { node, signature });
  return node;
}

function renderThreadList() {
  const list = document.getElementById("thread-list");
  if (!list) return;
  renderThreadFilters();
  const rows = [];
  const shown = new Set();
  const groups = new Set();
  for (const group of groupThreads(state.threads)) {
    const [head, ...older] = group;
    // The generation you are reading is why its conversation is on screen —
    // never leave it folded away behind a click.
    if (older.some((thread) => thread.id === state.activeThread?.id)) expandedGroups.add(head.sessionKey);
    rows.push(threadCard(head));
    shown.add(head.id);
    if (!older.length) continue;
    const open = expandedGroups.has(head.sessionKey);
    groups.add(head.sessionKey);
    rows.push(olderToggle(head.sessionKey, older.length, open));
    if (open) {
      for (const thread of older) {
        rows.push(threadCard(thread, true));
        shown.add(thread.id);
      }
    }
  }
  // Cards for threads that left the list (deleted, filtered out, folded away)
  // have no reader and would otherwise pin their nodes forever.
  for (const id of cardCache.keys()) if (!shown.has(id)) cardCache.delete(id);
  for (const key of toggleCache.keys()) if (!groups.has(key)) toggleCache.delete(key);
  if (!rows.length) {
    rows.push(h("div", { class: "text-xs opacity-60 px-2 py-4 text-center" },
      state.query || state.filterSource || state.workspaceFilter ? "Nothing matches." : "No threads yet."));
  }
  syncChildren(list, rows);
}

/**
 * Workspace and channel filters. They are not part of the resting page: the head
 * of the column is one search row, and the filter line only unfolds under it
 * when the reader asks for it with the toolbar glyph — or when a filter is on,
 * because a list that is quietly hiding threads has to say so.
 *
 * Each select appears only when it has more than one thing to choose between,
 * and the glyph itself stays hidden while there is nothing worth filtering: with
 * a single workspace and a single bot, both would be dropdowns with one real
 * option.
 */
let renderedFilters = "";
let filtersOpen = false;

function toggleFilters() {
  // The line refuses to fold away while a filter is on, so there the glyph takes
  // its other meaning — clear the filters — instead of becoming a dead click.
  if (state.workspaceFilter || state.filterSource) {
    state.workspaceFilter = "";
    state.filterSource = "";
    filtersOpen = false;
    for (const select of document.querySelectorAll("#thread-filters .bare-select")) select.value = "";
    refreshThreads(); // repaints the list, and with it the filter line
    return;
  }
  filtersOpen = !filtersOpen;
  renderThreadFilters();
  if (filtersOpen) document.querySelector("#thread-filters .bare-select")?.focus();
}

function renderThreadFilters() {
  const slot = document.getElementById("thread-filters");
  if (!slot) return;
  const sources = [...state.sources].sort();
  const workspaces = state.overview?.workspaces ?? [];
  const offered = (workspaces.length > 1 ? 1 : 0) + (sources.length > 1 ? 1 : 0);
  const active = Boolean(state.workspaceFilter || state.filterSource);
  const toggle = document.getElementById("filter-toggle");
  if (toggle) {
    toggle.hidden = !offered;
    toggle.classList.toggle("is-active", active);
    toggle.title = active ? "clear filters" : "filters";
    toggle.setAttribute("aria-label", active ? "Clear filters" : "Filters");
    toggle.setAttribute("aria-expanded", String(Boolean(offered) && (filtersOpen || active)));
  }
  slot.hidden = !offered || !(filtersOpen || active);
  const signature = `${workspaces.join(",")}|${sources.join(",")}`;
  if (signature === renderedFilters) return; // never rebuild a select under an open menu
  renderedFilters = signature;
  const filter = (key, all, options) =>
    h("select", {
      class: "bare-select",
      title: `filter by ${key === "workspaceFilter" ? "workspace" : "channel"}`,
      onchange: (event) => { state[key] = event.target.value; refreshThreads(); },
    },
      h("option", { value: "" }, all),
      options.map((option) => h("option", { value: option, selected: state[key] === option }, option)),
    );
  slot.replaceChildren(
    ...(workspaces.length > 1 ? [filter("workspaceFilter", "all workspaces", workspaces)] : []),
    ...(sources.length > 1 ? [filter("filterSource", "all channels", sources)] : []),
  );
}

// The list is server-ordered by last activity and only refetched on events, so
// on a quiet daemon the "5m" labels silently drift and make that order look
// wrong. Retick just the label text — rebuilding the cards would restart the
// live-halo animations.
setInterval(() => {
  if (!onThreadsView()) return; // no list on screen, nothing to retick
  for (const label of document.querySelectorAll("#thread-list [data-since]")) {
    label.textContent = timeAgo(Number(label.dataset.since));
  }
}, 30_000);

// Guards against an older /threads/:id response landing after a newer one (or
// after the reader moved on to another thread) and painting stale history.
let openSeq = 0;
// Bumped whenever the running turn's live record is invalidated (a turn started,
// or failed over), so an in-flight fetch can tell its snapshot is already old.
let liveEpoch = 0;

async function openThread(id) {
  const seq = ++openSeq;
  const epoch = liveEpoch;
  if (id !== state.activeThread?.id) {
    // Switching threads: nothing from the old one survives the move.
    state.live = [];
    state.liveStartedAt = 0;
    state.tasks = { plan: [], agents: [], agentTotal: 0 };
    state.pending = [];
  }
  const data = await withLoading(() => api.get(`/threads/${id}`).catch(() => null));
  if (!data || seq !== openSeq) return false;
  state.activeThread = data.thread;
  // Keep the address bar on the thread actually open, so it can be reloaded,
  // bookmarked or linked to from the Usage page. replaceState rather than
  // assigning to location.hash: that would fire hashchange and rebuild the
  // whole view underneath the thread we just fetched. The entry's own state
  // rides along untouched — it is what says this is a pane the back gesture
  // may close (see openPaneMobile).
  if (onThreadsView()) history.replaceState(history.state, "", `#/threads/${data.thread.id}`);
  // This read is fresher than the last list read — let it correct the halo (and
  // the stop button) for the thread being opened.
  setServerRunning(data.thread.id, data.thread.running);
  state.timeline = data.timeline ?? [];
  state.requests = data.requests ?? [];
  state.pending = state.pending.filter((message) => !landed(message));
  if (epoch === liveEpoch) {
    // No live turn means the turn is over and everything it produced is now in
    // the transcript. With one running, the server snapshot is only a catch-up
    // for a page that missed events — once we're receiving them ourselves, ours
    // is the complete record and the snapshot would lose the newest deltas.
    if (!data.live) {
      state.live = [];
      state.liveStartedAt = 0;
      // The board outlives the turn on purpose: the finished plan is the most
      // useful thing on screen right after a long run.
    } else {
      // The daemon's clock, which is also the transcript's — so the cut-off it
      // gives is directly comparable with the rows' own timestamps.
      state.liveStartedAt = data.live.startedAt ?? state.liveStartedAt;
      if (!state.live.length) state.live = data.live.items ?? [];
      if (hasTasks(data.live.tasks)) state.tasks = data.live.tasks;
    }
  }
  renderThreadPane();
  renderThreadList();
  return true;
}

// A pending bubble is redundant once the same message shows up in the
// transcript. Compare a prefix: the activity broadcast clips long messages.
const landed = (pending) =>
  state.timeline.some((item) => item.kind === "message" && sameMessage(item, pending, MATCH_CHARS));

/**
 * Put a message inside the running turn, at the point it arrived. This is what
 * a mid-turn message needs: it is steered into the turn that is already going,
 * so its place in the conversation is *between* two of that turn's tool calls —
 * not above the whole turn, which is where every region-based placement put it.
 * Returns the live item, so a locally sent one can still be corrected or undone.
 */
function pushLiveMessage(message) {
  const existing = state.live.find((item) => item.kind === "message" && sameMessage(item, message, MATCH_CHARS));
  if (existing) {
    // The daemon's echo of a message this page sent (now with absolute media
    // paths and any voice transcript) — upgrade it where it already is.
    existing.text = message.text;
    renderLive(true);
    return existing;
  }
  const item = { kind: "message", role: message.role, text: message.text, at: Date.now() };
  state.live.push(item);
  renderLive();
  return item;
}

/** Show a message that isn't in the transcript yet (and won't be until the turn
 *  persists it), unless it's already on screen. An attachment sent here starts
 *  life as an upload receipt; the activity event carries the daemon's final
 *  body (absolute path and voice transcript), so upgrade that bubble in place. */
function showPending(role, text) {
  const message = { role, text, activity: true };
  if (landed(message)) return;
  const existing = state.pending.find((pending) => sameMessage(pending, message, MATCH_CHARS));
  if (existing) existing.text = text;
  else state.pending.push(message);
  renderPending();
}

// A message that arrives outside a turn (an operator send) has no turn-done to
// refresh on, so re-read the transcript shortly after any activity. Coalesced:
// a burst of events costs one read.
let reconcileTimer;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => state.activeThread && openThread(state.activeThread.id), 1500);
}

// On mobile the list and the conversation share one screen; these swap between
// them (a no-op on desktop, where both panes are always visible side by side).
const threadsLayout = () => document.getElementById("threads-layout");
const showPane = () => threadsLayout()?.classList.add("pane-open");

/**
 * Open the conversation pane over the list — and, on a phone, record that as a
 * navigation.
 *
 * Two screens the reader moves between are two history entries, or the back
 * gesture means "leave eleven" the whole time a thread is open. Installed as an
 * app that is worse still: Android's back button is the only one there is, and
 * it would close the app rather than return to the list. The entry carries a
 * `pane` marker so a back that lands *outside* it (a deep link opened cold) can
 * be told from one this page pushed.
 */
function openPaneMobile(threadId) {
  const layout = threadsLayout();
  if (!layout) return;
  if (isPhone() && !layout.classList.contains("pane-open")) {
    history.pushState({ pane: true }, "", threadId ? `#/threads/${threadId}` : "#/threads");
  }
  layout.classList.add("pane-open");
}

/** Back to the list. Through history when the pane got there through history,
 *  so the ‹ button and the back gesture leave the same trail behind them. */
function closePaneMobile() {
  const layout = threadsLayout();
  if (!layout?.classList.contains("pane-open")) return;
  if (history.state?.pane) return history.back(); // popstate below drops the class
  layout.classList.remove("pane-open");
}
// Mobile-only ‹ that returns from the conversation/compose pane to the list.
const backButton = () =>
  h("button", { class: "btn btn-ghost btn-sm mobile-only px-2", "aria-label": "Back to threads", onclick: closePaneMobile },
    h("span", { html: "‹", style: "font-size:1.3rem;line-height:1" }));

// One tool call, rendered identically for the live row and the durable
// transcript — same markup, same place in the flow, so a reload mid-turn
// doesn't visibly rearrange the page. The arg preview is truncated to a single
// line by CSS; a row with a call id opens the modal with the full args and the
// recorded result. Live rows carry the same id the record is written under, so
// they're clickable while the turn runs — the result simply isn't there yet.
function toolCallRow({ name, summary, args, id }) {
  return h("div", {
    class: `tool-call${id ? " is-clickable" : ""}`,
    ...(id ? { title: "view arguments and result", onclick: () => openToolCallModal(name, args, id) } : {}),
  },
    h("span", { class: "tool-call-name" }, name),
    summary ? h("span", { class: "tool-call-arg" }, summary) : null,
    id ? h("span", { class: "tool-call-open", "aria-hidden": "true" }, "›") : null,
  );
}

/** A run of consecutive tool calls, as its own transcript row. */
const toolCallsBlock = (calls) => h("div", { class: "tool-calls" }, calls.map(toolCallRow));

/** A turn that gave up, in the place it gave up. The toast that fires at the
 *  same moment is the notification; this is the record — it is still here
 *  tomorrow, which is what makes "it never answered me" a debuggable claim. */
const turnErrorRow = (text) =>
  h("div", { class: "turn-error" },
    h("span", { class: "turn-error-mark" }, "⚠"),
    h("span", { class: "min-w-0" }, text),
  );

/** The client's side of the media-note convention, for the bubble shown while a
 *  message is still in flight — it has receipts, not paths. */
const withMediaNotes = (text, attachments) =>
  [text, ...attachments.map((item) => `[media attached: ${item.id} (${item.mime})]`)].filter(Boolean).join("\n\n");

function mediaAttachment({ id, mime }) {
  const url = mediaUrl(id, mime);
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(mime)) {
    return h("a", { class: "msg-media-frame", href: url, target: "_blank", rel: "noopener" },
      h("img", { class: "msg-media", src: url, alt: mediaName(id), loading: "lazy" }));
  }
  if (mime.startsWith("audio/")) return h("audio", { class: "msg-audio", src: url, controls: true, preload: "metadata" });
  if (mime.startsWith("video/")) return h("video", { class: "msg-media", src: url, controls: true, preload: "metadata" });
  // Anything else is a download — the daemon will not serve it as a document,
  // and a link is the honest affordance for that.
  return h("a", { class: "msg-file", href: url, download: mediaName(id) },
    h("span", { class: "attach-glyph", "aria-hidden": "true", html: FILE_ICON }),
    h("span", { class: "attach-meta min-w-0" },
      h("span", { class: "attach-name truncate" }, mediaName(id)),
      h("span", { class: "attach-size" }, mime || "file"),
    ),
  );
}

/**
 * One message. `grouped` means the previous row was the same speaker moments
 * ago, so the bubble tucks under it instead of opening a new block; the
 * timestamp is rendered on every message and CSS hides the ones a grouped
 * follower makes redundant, which keeps the time visible exactly once per run
 * of messages without the builder having to look ahead.
 */
function messageBubble(message, { streaming = false, grouped = false, at } = {}) {
  const isUser = message.role === "user";
  // ⚡ is deliberately literal: it exposes the prompt instead of replacing its
  // media-note lines with the friendly attachment preview.
  const { text, media } = presentMessage(message.text, state.showRequests);
  return h("div", { class: `chat ${isUser ? "chat-end" : "chat-start"}${grouped ? " is-grouped" : ""}` },
    h("div", { class: `chat-bubble${streaming ? " msg-streaming" : ""}` },
      media.length ? h("div", { class: "msg-attachments" }, media.map(mediaAttachment)) : null,
      text ? h("div", { class: "msg-body", html: md(text) }) : null,
    ),
    at ? h("time", { class: "msg-time", datetime: new Date(at).toISOString() }, clock(at)) : null,
  );
}

/* The transcript is three stacked regions inside one scroller:
   #transcript  — the durable rows, rebuilt only when the session file is read
   #pending     — messages that exist but aren't persisted yet
   #live        — the running turn, appended to as events arrive
   Splitting them is what keeps a delta stream from re-rendering all of history
   (and what lets the live region be replaced wholesale when a turn restarts). */

const scroller = () => document.getElementById("messages");

// Mutate the transcript while keeping a reader who scrolled up in place, and a
// reader at the bottom pinned to the newest row.
function sticky(mutate) {
  const el = scroller();
  const stick = el ? atBottom(el) : false;
  mutate();
  if (el && stick) el.scrollTop = el.scrollHeight;
  else markUnreadBelow();
}

/** The durable transcript, as nodes. Ordering, day breaks, message grouping and
 *  which rows the running turn has already drawn are decided in live-turn.js —
 *  this only turns each row into markup. */
const durableRows = () =>
  transcriptRows({
    timeline: state.timeline,
    requests: state.requests,
    live: state.live,
    liveStartedAt: state.liveStartedAt,
    showRequests: state.showRequests,
  }).map(transcriptNode);

function transcriptNode(row) {
  if (row.kind === "day") return daySeparator(row.at);
  if (row.kind === "tool-calls") return toolCallsBlock(row.calls);
  if (row.kind === "error") return turnErrorRow(row.text);
  if (row.kind === "request") return requestChip(row.request);
  return messageBubble(row.message, { grouped: row.grouped, at: row.at });
}

const daySeparator = (at) => h("div", { class: "day-sep" }, h("span", {}, dayLabel(at)));

function renderPending() {
  const region = document.getElementById("pending");
  if (!region) return;
  sticky(() => region.replaceChildren(...state.pending.map((message) => messageBubble(message))));
}

// The live region only ever grows, so nodes are appended rather than rebuilt —
// one delta must not cost a re-render of the turn so far. `liveRendered` is how
// many of state.live already have a node; a shrink (or an explicit rebuild)
// starts the region over.
let liveRendered = 0;
function renderLive(rebuild = false) {
  const region = document.getElementById("live");
  if (!region) return;
  sticky(() => {
    if (rebuild || liveRendered > state.live.length) {
      region.replaceChildren();
      liveRendered = 0;
    }
    for (let i = liveRendered; i < state.live.length; i++) {
      const item = state.live[i];
      const previous = region.lastElementChild;
      // Consecutive calls join one block — the same merged shape the transcript
      // renders after a reload.
      if (item.kind === "tool" && previous?.classList.contains("tool-calls")) previous.append(toolCallRow(item));
      else region.append(liveNode(item));
    }
    liveRendered = state.live.length;
    // The trailing prose bubble grows delta by delta — patch it in place.
    const last = state.live.at(-1);
    const body = last?.kind === "text" ? region.lastElementChild?.querySelector(".msg-body") : undefined;
    if (body) body.innerHTML = md(last.text);
  });
  updateLiveStatus();
}

function liveNode(item) {
  if (item.kind === "tool") return toolCallsBlock([item]);
  if (item.kind === "request") {
    return state.showRequests ? requestChip({ id: item.id, model: item.model, at: item.at, bytes: 0 }) : h("div", { hidden: true });
  }
  // A message that arrived mid-turn: an ordinary bubble, in the ordinary flow,
  // at the point in the turn where it actually landed.
  if (item.kind === "message") return messageBubble({ role: item.role, text: item.text }, { at: item.at });
  return messageBubble({ role: "assistant", text: item.text }, { streaming: true });
}

/* The turn's plan and its subagents, under the transcript. Not part of the live
   region: that region is a log that only grows, while this is state that gets
   replaced — a plan whose rows move from pending to done, and a roster of
   agents reporting as they run. It outlives the turn, because a finished plan
   is the most useful thing on screen right after a long one. */

function renderTasks() {
  const region = document.getElementById("tasks");
  if (!region) return;
  const { plan = [], agents = [], agentTotal } = state.tasks ?? {};
  // The plan arrives grouped by producer: the session's own (unlabelled) and
  // one group per tool reporting its internal phases. Merged into one list, a
  // reader cannot tell the work they asked for from a tool's bookkeeping.
  const sections = plan
    .filter((section) => section?.tasks?.length)
    .map((section) => taskSection(section.label ?? "Plan", section.tasks, planRow));
  if (agents.length) sections.push(taskSection("Agents", agents, agentRow, agentTotal ?? agents.length));
  sticky(() => region.replaceChildren(...sections));
}

/** `total` is how many exist, not how many arrived — a producer may cap the
 *  rows it sends, and counting the rows would understate a wide fan-out. */
function taskSection(title, tasks, row, total = tasks.length) {
  const hidden = total - tasks.length;
  return h("div", { class: "task-section" },
    h("div", { class: "task-section-title" }, title),
    ...tasks.map(row),
    hidden > 0 ? h("div", { class: "task-row task-more" }, `… ${hidden} more`) : null,
  );
}

const planRow = (task) =>
  h("div", { class: `task-row is-${task.status}` },
    h("span", { class: "task-icon", "aria-hidden": "true" }, taskIcon(task)),
    h("span", { class: "task-title" }, task.title),
    task.blockedBy?.length
      ? h("span", { class: "task-meta" }, `blocked by ${task.blockedBy.map((id) => `#${displayId(id)}`).join(", ")}`)
      : null,
  );

/** A subagent row opens what the runtime reported about that agent. There is no
 *  per-agent provider request to link to — a nested runtime drives its own tool
 *  loop, so those calls never reach the request log — and the panel says so
 *  rather than leaving a reader hunting for a link that cannot exist. */
function agentRow(task) {
  const meta = agentMeta(task);
  return h("div", {
    class: `task-row is-${task.status} is-clickable`,
    title: "view what this agent reported",
    onclick: () => openAgentModal(task),
  },
    h("span", { class: "task-icon", "aria-hidden": "true" }, taskIcon(task)),
    h("span", { class: "task-title" }, task.title),
    meta.length ? h("span", { class: "task-meta" }, meta.join(" · ")) : null,
    h("span", { class: "task-open", "aria-hidden": "true" }, "›"),
  );
}

function openAgentModal(task) {
  const body = h("div", { class: "agent-detail" },
    ...agentDetail(task).map(([label, value]) =>
      h("div", { class: "agent-detail-row" },
        h("span", { class: "agent-detail-label" }, label),
        h("span", { class: "agent-detail-value font-mono" }, value),
      ),
    ),
    task.summary ? h("p", { class: "agent-detail-summary" }, task.summary) : null,
    h("p", { class: "agent-detail-note" },
      "Only what the runtime reported for this agent. Its own provider requests are not in the request log: "
      + "a subagent runs inside a nested tool loop whose calls eleven never sees."),
  );
  openModal("Agent", task.title, [], body);
}

/* The line under the transcript while a turn runs: a spinner, what the turn is
   doing, and how long it has been at it. The gap between "sent" and the first
   token used to look like a hang, and a long tool call still does — this is the
   page saying it is alive, and saying what it is busy with. */

/** When a delta last arrived, anywhere — so the status can tell prose that is
 *  still streaming from prose that stopped a minute ago. */
let lastDeltaAt = 0;

function updateLiveStatus() {
  const row = document.getElementById("live-status");
  if (!row) return;
  row.querySelector(".live-status-label").textContent = liveStatus(state.live, { lastDeltaAt });
  row.querySelector(".live-status-time").textContent = state.liveStartedAt ? elapsed(state.liveStartedAt) : "";
}

// The label ages on its own (prose stops, the clock ticks), so it is re-read
// once a second rather than only when an event happens to arrive.
setInterval(() => {
  if (state.activeThread && isThreadLive(state.activeThread.id)) updateLiveStatus();
}, 1000);

// Deltas arrive dozens of times per second — coalesce to one render per frame.
let liveRaf;
function scheduleLiveRender() {
  liveRaf ??= requestAnimationFrame(() => {
    liveRaf = undefined;
    renderLive();
  });
}

/* The head of the conversation: what you are reading on the first line, where
   it lives on the second, and the controls that act on it at the far end.
   `delete` is deliberately not one of them — it hides behind the ⋯, because the
   most destructive button on the page had been sitting one stray click away
   from the scrollbar. */
function threadHeader(thread) {
  const model = thread.effectiveModel ?? thread.model;
  return h("header", { class: "thread-head" },
    backButton(),
    h("div", { class: "thread-head-text min-w-0" },
      h("div", { class: "thread-head-title truncate" }, thread.title ?? "(untitled)"),
      h("div", { class: "thread-head-meta" },
        channelSource(thread.sessionKey),
        // The conversation in words; the raw session key stays one hover away.
        h("span", { class: "truncate", title: thread.sessionKey }, withoutChannelPrefix(thread.conversation, thread.sessionKey)),
        h("span", { class: "meta-sep" }, "·"),
        h("span", { class: "text-warning shrink-0" }, thread.workspace),
        model ? h("span", { class: "meta-sep" }, "·") : null,
        model ? h("span", { class: "font-mono truncate", title: "model leading this thread" }, model) : null,
        ...threadUsageMeta(thread.usage),
      ),
    ),
    h("div", { class: "thread-head-actions" },
      // Says the same thing the sign in the sidebar does, at the one place a
      // reader of this thread is already looking.
      h("span", { class: "running-pill" }, h("i", { class: "spinner" }), "running"),
      h("button", {
        class: `toolbar-icon${state.showRequests ? " is-active" : ""}`,
        title: state.showRequests ? "hide diagnostics" : "show provider requests and exact agent messages",
        "aria-label": "Diagnostics",
        "aria-pressed": String(state.showRequests),
        onclick: toggleRequests,
      }, "⚡"),
      threadMenu(thread),
    ),
  );
}

/**
 * What this conversation has burned, in the header where its model already is.
 *
 * The window figure is the one to watch: how full the context was on the last
 * response, and so how close the thread is to a compaction — itself a paid
 * call. The server only sends it when the last response really was one request,
 * which rules out the runtimes that persist a whole tool loop as a single row.
 */
function threadUsageMeta(usage) {
  if (!usage) return [];
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const parts = [`${fmtTokens(prompt + usage.output)} tokens`];
  if (prompt) parts.push(`${fmtPercent(usage.cacheRead / prompt)} cached`);
  const fill = usage.contextWindow ? usage.lastPromptTokens / usage.contextWindow : undefined;
  const nodes = [
    h("span", { class: "meta-sep" }, "·"),
    h("span", {
      class: "shrink-0",
      title: `${prompt.toLocaleString()} prompt + ${usage.output.toLocaleString()} output tokens · list price ${fmtMoney(usage.cost)}`,
    }, parts.join(" · ")),
  ];
  if (fill !== undefined) {
    nodes.push(h("span", { class: "meta-sep" }, "·"));
    nodes.push(h("span", {
      class: `shrink-0${fill >= 0.85 ? " text-error" : fill >= 0.6 ? " text-warning" : ""}`,
      title: `last response carried ${usage.lastPromptTokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} context tokens`,
    }, `${fmtPercent(fill)} window`));
  }
  return nodes;
}

function toggleRequests() {
  state.showRequests = !state.showRequests;
  prefs.set("requests", state.showRequests ? "1" : "0");
  renderThreadPane();
}

/** The ⋯ overflow. Native <details> so Escape and click-outside are the only
 *  things left to wire up, and so it needs no focus bookkeeping of its own. */
function threadMenu(thread) {
  const id = thread.id;
  const menu = h("details", { class: "thread-menu" },
    h("summary", { class: "toolbar-icon", title: "more", "aria-label": "More actions" }, "⋯"),
    h("div", { class: "thread-menu-body" },
      h("button", {
        class: "menu-item",
        title: "start a fresh thread in this same conversation — the /new command",
        onclick: () => { menu.open = false; startFreshThread(thread); },
      }, "New thread here"),
      h("button", {
        class: "menu-item",
        title: "the skills a turn in this thread can load — the /skills command",
        onclick: () => { menu.open = false; openSkillsModal(thread); },
      }, "Skills"),
      h("button", { class: "menu-item", onclick: () => { menu.open = false; copyText(id, "Thread id copied."); } }, "Copy thread id"),
      deleteThreadButton(id),
    ),
  );
  return menu;
}

/**
 * Rotate the conversation on screen: the same thing /new does in Telegram, for
 * the thread you are reading. Nothing is deleted — the old thread stays in the
 * list, it simply stops being the one the conversation talks to.
 */
async function startFreshThread(thread) {
  let started;
  try {
    started = await api.send("POST", `/threads/${thread.id}/new`, {});
  } catch (error) {
    return toast(error.message, true);
  }
  toast("Fresh thread started.");
  await refreshThreads();
  await openThread(started.id);
  openPaneMobile();
}

// One listener for every popover on the page: a click that isn't inside an open
// <details> closes it, and so does Escape.
document.addEventListener("click", (event) => {
  for (const open of document.querySelectorAll("details.thread-menu[open]")) {
    if (!open.contains(event.target)) open.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const open of document.querySelectorAll("details.thread-menu[open]")) open.open = false;
});

const copyText = (text, message) => navigator.clipboard.writeText(text).then(() => toast(message), () => toast("Could not copy.", true));

/** Grows with what's typed instead of scrolling inside three fixed rows, and
 *  stops at a height that still leaves the conversation visible. */
function autoGrow(textarea) {
  const fit = () => {
    textarea.style.height = "auto";
    // Off screen (the pane a phone isn't showing) there is no scrollHeight to
    // measure, and pinning the box to 0px would keep it collapsed once shown.
    if (!textarea.scrollHeight) return;
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  };
  textarea.addEventListener("input", fit);
  // The first fit has to wait for the element to be in the document — before
  // that scrollHeight is 0 and the box would collapse.
  requestAnimationFrame(fit);
  return textarea;
}

/* ---------- attachments ---------- */

/* Files a composer is holding, keyed the same way drafts are. Unlike a draft
   these are already on the daemon by the time they show up as a chip — the
   upload starts the moment the file is picked, so pressing Enter sends a list
   of receipts rather than a request that has to carry megabytes. They are not
   persisted: an upload is seconds-old work, and the sweep would outlive the
   tab's memory of it anyway. */
const attached = new Map();

/** How a stored file is fetched back — for a thumbnail here, or a download.
 *  The type travels with it because the daemon refuses to guess: only the
 *  renderable kinds are ever served as themselves. */
const mediaUrl = (id, mime) => `/api/media/${encodeURIComponent(id)}${mime ? `?type=${encodeURIComponent(mime)}` : ""}`;
/** The name as the user knows it — stored ids carry a uniquifying prefix. */
const mediaName = (id) => id.replace(/^[0-9a-f]{8}-/, "");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirrors the daemon's own ceiling

async function uploadFile(file) {
  const response = await fetch(`/api/media?name=${encodeURIComponent(file.name || "attachment")}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  return ok(response);
}

/**
 * The attachment half of a composer: the tray of chips, the paperclip, the mic,
 * and the recorder that takes the box's place while one is running. Both
 * composers (a thread's and the launcher's) build one and place the pieces
 * themselves — what they share is everything that decides *what is attached*.
 */
function composerAttachments(key, { form, textarea, onChange = () => {} }) {
  const tray = h("div", { class: "attach-tray", hidden: true });
  const items = () => attached.get(key) ?? [];
  const setItems = (next) => (next.length ? attached.set(key, next) : attached.delete(key));

  /** `notify` is off for the first paint: a composer rebuilt over a tray that
   *  already had files in it (reopening the launcher, coming back to a thread)
   *  is restoring state, not changing it — and its caller isn't built yet. */
  function render(notify = true) {
    const list = items();
    tray.hidden = !list.length;
    tray.replaceChildren(...list.map((item) => chip(item)));
    if (notify) onChange();
  }

  function remove(item) {
    setItems(items().filter((entry) => entry !== item));
    render();
  }

  function chip(item) {
    const image = item.mime.startsWith("image/") && item.id;
    return h("div", { class: `attach-chip${item.uploading ? " is-uploading" : ""}` },
      image
        ? h("img", { class: "attach-thumb", src: mediaUrl(item.id, item.mime), alt: "" })
        : h("span", { class: "attach-glyph", "aria-hidden": "true", html: item.voice ? MIC_ICON : FILE_ICON }),
      h("span", { class: "attach-meta min-w-0" },
        h("span", { class: "attach-name truncate" }, item.voice ? "Voice message" : item.name),
        h("span", { class: "attach-size" }, item.uploading ? "uploading…" : item.voice && item.seconds ? clockDuration(item.seconds) : fmtBytes(item.bytes)),
      ),
      h("button", { class: "attach-remove", type: "button", "aria-label": `Remove ${item.name}`, onclick: () => remove(item), html: X_ICON }),
    );
  }

  /** Attach a File/Blob: the chip appears immediately and fills itself in, so a
   *  20 MB video looks like it is being worked on instead of like a freeze. */
  function add(file, { voice = false, seconds = 0 } = {}) {
    if (file.size > MAX_UPLOAD_BYTES) return toast(`${file.name || "That file"} is over ${fmtBytes(MAX_UPLOAD_BYTES)}.`, true);
    const item = { name: file.name || (voice ? "voice-note" : "attachment"), mime: file.type || "", bytes: file.size, voice, seconds, uploading: true };
    setItems([...items(), item]);
    item.upload = uploadFile(file).then(
      (stored) => {
        item.id = stored.id;
        item.mime = stored.mime || item.mime;
        item.uploading = false;
        render();
      },
      (error) => {
        toast(error.message, true);
        remove(item);
      },
    );
    render();
  }

  const picker = h("input", {
    type: "file",
    multiple: true,
    class: "sr-only",
    onchange: (event) => {
      for (const file of event.target.files) add(file);
      event.target.value = ""; // so picking the same file twice in a row still fires
    },
  });

  // Ctrl+V: a screenshot is the single most common thing anyone attaches, and
  // it never exists as a file on disk to pick. `items` is read as well as
  // `files` because a clipboard image is an item some browsers never list as a
  // file. Only intercept when something came back — pasting text stays text.
  textarea.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    const files = data?.files.length
      ? [...data.files]
      : [...(data?.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) add(file);
  });

  // Dropping onto the composer, with the box lighting up so it is clear where
  // the file is going. dragleave fires when the pointer crosses a child too,
  // hence the depth counter.
  let dragDepth = 0;
  form.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (dragDepth++ === 0) form.classList.add("is-dropping");
  });
  form.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  form.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; form.classList.remove("is-dropping"); }
  });
  form.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    dragDepth = 0;
    form.classList.remove("is-dropping");
    for (const file of files) add(file);
  });

  // The input is a sibling of the button, not a child: a form control inside a
  // <button> is invalid, and browsers disagree about what happens to its clicks.
  const attachButton = h("span", { class: "composer-attach" },
    h("button", {
      class: "composer-icon",
      type: "button",
      title: "Attach a file (or paste one)",
      "aria-label": "Attach a file",
      onclick: () => picker.click(),
      html: CLIP_ICON,
    }),
    picker,
  );

  const recorder = voiceRecorder(form, (blob, seconds) => add(blob, { voice: true, seconds }));
  render(false);

  return {
    tray,
    attachButton,
    micButton: recorder.button,
    recorderBar: recorder.bar,
    /** Wait for every in-flight upload, then the receipts to send. A chip whose
     *  upload failed is already gone, so what is left is what arrived. */
    async refs() {
      await Promise.all(items().map((item) => item.upload));
      return items().filter((item) => item.id).map(({ id, mime, voice }) => ({ id, mime, voice }));
    },
    any: () => items().length > 0,
    clear() {
      recorder.cancel();
      attached.delete(key);
      render();
    },
  };
}

const clockDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// What the browser will actually record in, best first. Chrome only does webm,
// Firefox prefers ogg, Safari gives mp4 — asking in order is the whole of the
// portability story, since the daemon stores whatever bytes arrive.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
const RECORDING_EXT = { webm: "webm", ogg: "ogg", mp4: "m4a" };
const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/* The take in progress, if any. A composer is torn down by things its recorder
   never hears about — opening another thread, a route change — and a microphone
   left live behind a screen nobody is looking at is not an acceptable way to
   lose track of state. */
let liveRecording;
const stopRecording = () => liveRecording?.();

/**
 * Hold-nothing voice recording: press the mic, the composer turns into a
 * recorder with a running clock, and the take lands in the tray as an ordinary
 * attachment — so it can be sent with text next to it, or thrown away. The
 * daemon transcribes it on arrival exactly like a Telegram voice note.
 */
function voiceRecorder(form, onTake) {
  const elapsed = h("span", { class: "recorder-time font-mono" }, "0:00");
  let recorder;
  let stream;
  let ticker;
  let stopWaveform;
  let startedAt = 0;
  let keep = true;

  const button = h("button", {
    class: "composer-icon",
    type: "button",
    title: "Record a voice message",
    "aria-label": "Record a voice message",
    hidden: !canRecord(),
    onclick: () => start(),
    html: MIC_ICON,
  });

  function teardown() {
    clearInterval(ticker);
    ticker = undefined;
    stopWaveform?.();
    stopWaveform = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    recorder = undefined;
    liveRecording = undefined;
    form.classList.remove("is-recording");
  }

  async function start() {
    if (recorder) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      // Denied permission, no device, or an insecure origin — getUserMedia only
      // exists over https or on localhost, and a tunnel without TLS lands here.
      return toast(`Microphone unavailable: ${error.message ?? error}`, true);
    }
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    keep = true;
    recorder.addEventListener("dataavailable", (event) => event.data.size && chunks.push(event.data));
    recorder.addEventListener("stop", () => {
      const seconds = (Date.now() - startedAt) / 1000;
      const type = (recorder?.mimeType || mimeType || "audio/webm").split(";", 1)[0];
      teardown();
      if (!keep || !chunks.length) return;
      const blob = new File(chunks, `voice-note.${RECORDING_EXT[type.split("/")[1]] ?? "webm"}`, { type });
      onTake(blob, seconds);
    });
    recorder.addEventListener("error", (event) => {
      toast(`Recording failed: ${event.error?.message ?? "unknown error"}`, true);
      keep = false;
      teardown();
    });
    startedAt = Date.now();
    elapsed.textContent = "0:00";
    recorder.start();
    stopWaveform = connectWaveform(stream, [...waveform.children]);
    liveRecording = () => finish(false);
    form.classList.add("is-recording");
    ticker = setInterval(() => (elapsed.textContent = clockDuration((Date.now() - startedAt) / 1000)), 250);
  }

  function finish(shouldKeep) {
    if (!recorder) return;
    keep = shouldKeep;
    // 'stop' does the work — it is the only point where the last chunk is in.
    if (recorder.state !== "inactive") recorder.stop();
    else teardown();
  }

  const waveform = h("div", { class: "recorder-waveform", role: "img", "aria-label": "Live microphone level" },
    Array.from({ length: WAVEFORM_BAR_COUNT }, () => h("i", { class: "recorder-waveform-bar" })),
  );
  const bar = h("div", { class: "recorder" },
    h("span", { class: "recorder-dot", "aria-hidden": "true" }),
    h("span", { class: "recorder-label" }, "Recording"),
    elapsed,
    waveform,
    h("button", { class: "composer-icon", type: "button", title: "Discard", "aria-label": "Discard recording", onclick: () => finish(false), html: X_ICON }),
    h("button", { class: "composer-icon is-primary", type: "button", title: "Keep", "aria-label": "Keep recording", onclick: () => finish(true), html: CHECK_ICON }),
  );

  return { button, bar, cancel: () => finish(false) };
}

/**
 * The footer of a thread that belongs to a channel. There is no composer,
 * because a turn typed here is a dashboard turn: it carries no channel tool and
 * nothing delivers it, so the reply would land in the transcript and never
 * reach the chat — a question and an answer invisible to the person on the
 * other end, in the middle of a conversation they are still reading.
 *
 * The stop button stays: a runaway turn is worth killing from wherever you are.
 * And the way forward is a thread of your own, in the same workspace.
 */
function readOnlyComposer(thread) {
  return h("div", { class: "composer composer-readonly" },
    h("div", { class: "composer-box" },
      h("p", { class: "composer-readonly-text" },
        "This thread lives in ", h("strong", {}, thread.conversation), ". Answer it there.",
      ),
      h("button", {
        class: "btn btn-sm",
        type: "button",
        title: "start a thread of your own here, in this thread's workspace",
        onclick: () => newThreadDialog(thread.workspace),
      }, "New thread"),
      h("button", {
        class: "composer-stop",
        type: "button",
        id: "stop-turn",
        title: "abort the running turn (and drop input still waiting to start one)",
        "aria-label": "Stop",
        onclick: () => stopTurn(thread.id),
      }, h("span", { class: "stop-square", "aria-hidden": "true" })),
    ),
  );
}

function threadComposer(thread) {
  if (thread.composable === false) return readOnlyComposer(thread);
  const text = autoGrow(h("textarea", {
    class: "composer-text",
    id: "composer-text",
    placeholder: `Message ${thread.workspace}…`,
    rows: "1",
    // The composer is per thread, so the draft is too — id, not "the composer".
    "data-thread": thread.id,
    oninput: (e) => drafts.set(thread.id, e.target.value),
    onkeydown: (e) => { if (sendsOnEnter(e)) { e.preventDefault(); e.target.form.requestSubmit(); } },
  }));
  // Before autoGrow's first fit (a frame away), so the box opens at the height
  // the restored draft needs instead of snapping to it.
  text.value = drafts.get(thread.id);
  const form = h("form", { class: "composer", onsubmit: sendMessage });
  const media = composerAttachments(thread.id, { form, textarea: text });
  // The submit handler reaches its attachments through the form it was fired
  // from — one composer is on screen at a time, but nothing has to assume it.
  form.attachments = media;
  form.append(
    media.tray,
    h("div", { class: "composer-box" },
      media.attachButton,
      text,
      media.micButton,
      h("button", { class: "composer-send", type: "submit", title: "Send (Enter)", "aria-label": "Send", html: SEND_ICON }),
      h("button", {
        class: "composer-stop",
        type: "button",
        id: "stop-turn",
        title: "abort the running turn (and drop input still waiting to start one)",
        "aria-label": "Stop",
        onclick: () => stopTurn(thread.id),
      }, h("span", { class: "stop-square", "aria-hidden": "true" })),
    ),
    media.recorderBar,
    h("div", { class: "composer-hint" }, "Enter to send · Shift+Enter for a new line · paste or drop to attach"),
  );
  return form;
}

/** Nothing open. An empty pane that only says so is a dead end — this one
 *  offers the two things you can actually do from here. */
function emptyPane() {
  return h("div", { class: "pane-empty" },
    h("div", { class: "pane-empty-mark display" }, "eleven"),
    h("p", { class: "pane-empty-line" }, "Pick a thread on the left to read it, or start a new one."),
    h("button", { class: "btn btn-primary", onclick: () => { newThreadDialog(); openPaneMobile(); } }, "New thread"),
  );
}

let renderedThreadId;
// Everything the head paints. A thread gets its title after the first turn and
// can change model mid-conversation, but neither happens on most re-renders —
// and rebuilding the head for nothing would snap a menu shut under the pointer.
let renderedHead;
const headSignature = (thread) =>
  `${thread.title}|${thread.conversation}|${thread.workspace}|${thread.effectiveModel ?? thread.model}|${state.showRequests}`;

/**
 * The pane is re-rendered by a great many things — a turn ending, a message
 * arriving, the reconcile that follows one. Only an actual thread switch
 * rebuilds it: everything else patches the parts that changed, because a
 * rebuild takes the composer with it, and with it the caret and whatever draft
 * was half-typed into it while the agent was still talking.
 */
function renderThreadPane() {
  const pane = document.getElementById("thread-pane");
  if (!pane) return;
  const thread = state.activeThread;
  pane.classList.remove("is-composing");
  // Anything below that replaces the pane takes a running recorder's UI with it.
  if (!thread || renderedThreadId !== thread.id) stopRecording();
  if (!thread) {
    renderedThreadId = undefined;
    renderedHead = undefined;
    pane.classList.remove("is-running");
    pane.replaceChildren(emptyPane());
    return;
  }
  // Re-rendering the same thread should leave a reader who scrolled up where
  // they were; switching threads or sitting at the bottom jumps to the latest.
  const prev = scroller();
  // The footer is the tell that this pane is built and current: a thread in
  // another channel has one without a text box, and testing for the box alone
  // would rebuild that pane on every event — scrolling the reader to the bottom
  // each time.
  const opened = renderedThreadId !== thread.id || !pane.querySelector(".composer");
  const keepScroll = !opened && prev && !atBottom(prev) ? prev.scrollTop : null;
  renderedThreadId = thread.id;
  pane.classList.toggle("is-running", isThreadLive(thread.id));

  if (opened) {
    // The scroller is full-width (its scrollbar belongs to the pane edge) but
    // the transcript inside it is capped at a readable measure: a bubble
    // stretched across a 1400px pane is a paragraph nobody can track a line in.
    pane.replaceChildren(
      threadHeader(thread),
      h("div", { class: "messages", id: "messages", onscroll: onTranscriptScroll },
        h("div", { class: "msg-col" },
          h("div", { id: "transcript" }, durableRows()),
          h("div", { id: "pending" }),
          h("div", { id: "live" }),
          h("div", { class: "task-board", id: "tasks" }),
          // Shown by CSS only while a turn is running; updateLiveStatus keeps
          // what it says current.
          h("div", { class: "live-status", id: "live-status", role: "status" },
            h("i", { class: "spinner", "aria-hidden": "true" }),
            h("span", { class: "live-status-label" }, "Thinking…"),
            h("span", { class: "live-status-time font-mono" }, ""),
          ),
        ),
      ),
      h("button", { class: "jump-bottom", id: "jump-bottom", hidden: true, title: "Jump to the newest message", onclick: () => scrollToBottom(true) },
        h("span", { html: ARROW_DOWN_ICON }), "Latest"),
      threadComposer(thread),
    );
    renderedHead = headSignature(thread);
  } else {
    if (renderedHead !== headSignature(thread)) {
      pane.querySelector(".thread-head")?.replaceWith(threadHeader(thread));
      renderedHead = headSignature(thread);
    }
    document.getElementById("transcript")?.replaceChildren(...durableRows());
  }

  // The regions live inside the pane, so they can only be filled once it's
  // attached; the scroll position is applied after, over the finished height.
  renderPending();
  renderLive(true);
  renderTasks();
  const messages = scroller();
  if (messages) messages.scrollTop = keepScroll ?? messages.scrollHeight;
  updateJumpButton();
  // Opening a thread is almost always the first half of answering in it, so the
  // caret lands in the composer. Not on a phone, where it would slide the
  // keyboard over the conversation you just tapped into.
  if (opened && !isPhone()) {
    const box = document.getElementById("composer-text");
    // At the end of a restored draft, not in front of it: you came back to
    // keep writing, not to insert a word before the first one.
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }
}

// Mirrors the `max-width: 768px` breakpoint in style.css — no build step here
// to share a constant, so the two have to be kept in sync by hand.
const phoneQuery = matchMedia("(max-width: 768px)");
const isPhone = () => phoneQuery.matches;

/**
 * Whether this Enter means "send".
 *
 * On a keyboard it does, and Shift+Enter is the newline. A soft keyboard has no
 * Shift to hold, so there the return key has to be the newline and the send
 * button is the only way to send — otherwise a message on a phone can never be
 * more than one line long. And an Enter that is closing an IME candidate is
 * choosing a word, not finishing a sentence.
 */
const sendsOnEnter = (event) => event.key === "Enter" && !event.shiftKey && !event.isComposing && !isPhone();

/* The "↓ Latest" pill. It exists because the transcript follows a running turn
   only while the reader is at the bottom — scroll up to read something and the
   page correctly stops moving, but then nothing on screen says the conversation
   went on without you. */
function updateJumpButton() {
  const button = document.getElementById("jump-bottom");
  const el = scroller();
  if (!button || !el) return;
  const away = !atBottom(el);
  button.hidden = !away;
  if (!away) button.classList.remove("has-new");
}
const onTranscriptScroll = () => updateJumpButton();
function scrollToBottom(smooth = false) {
  const el = scroller();
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  updateJumpButton();
}
/** Something arrived while the reader was up in the history — mark the pill. */
function markUnreadBelow() {
  const button = document.getElementById("jump-bottom");
  const el = scroller();
  if (button && el && !atBottom(el)) button.classList.add("has-new");
}

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function requestChip(request) {
  return h("button", {
    class: "request-chip font-mono text-xs",
    title: "open the recorded provider request",
    onclick: () => openRequestModal(request),
  }, "⚡", [request.model, request.bytes ? fmtBytes(request.bytes) : null, fmtTime(request.at)].filter(Boolean).join(" · "));
}

// ---- JSON viewer -------------------------------------------------------
// Provider payloads nest deep (system prompt, tool schemas, message history);
// a flat <pre> means scrolling past everything to find one field. This renders
// a collapsible, syntax-highlighted tree instead. Container nodes lazy-build
// their children on first open, so a huge payload costs nothing until you
// actually drill into it.

const isContainer = (v) => v !== null && typeof v === "object";

// Long strings (a whole system prompt lands in one value) would flood the
// panel, so anything over this many characters is clamped to a preview with a
// "more" toggle that reveals the rest in place.
const STRING_CLAMP = 240;

function jsonStringValue(value) {
  const full = JSON.stringify(value); // includes the surrounding quotes
  if (full.length <= STRING_CLAMP) return h("span", { class: "json-string" }, full);

  const span = h("span", { class: "json-string" });
  const text = h("span", {});
  const toggle = h("button", { class: "json-expand" });
  let open = false;
  const set = (o) => {
    open = o;
    text.textContent = open ? full : full.slice(0, STRING_CLAMP) + '…"';
    toggle.textContent = open ? "less" : `more (${full.length.toLocaleString()} chars)`;
  };
  toggle.addEventListener("click", (e) => { e.stopPropagation(); set(!open); }); // don't also toggle a parent branch
  set(false);
  span.append(text, " ", toggle);
  return span;
}

function jsonPrimitive(value) {
  if (value === null) return h("span", { class: "json-null" }, "null");
  const t = typeof value;
  if (t === "string") return jsonStringValue(value);
  if (t === "number") return h("span", { class: "json-number" }, String(value));
  if (t === "boolean") return h("span", { class: "json-bool" }, String(value));
  return h("span", {}, String(value));
}

// The "key:" prefix on a line — a quoted string for object members, a dim
// index for array elements, nothing for the root.
function jsonKey(key) {
  if (key === null) return [];
  const label = typeof key === "number"
    ? h("span", { class: "json-index" }, String(key))
    : h("span", { class: "json-key" }, `"${key}"`);
  return [label, h("span", { class: "json-punct" }, ": ")];
}

function jsonNode(key, value, depth, ctx) {
  if (!isContainer(value)) return h("div", { class: "json-line" }, ...jsonKey(key), jsonPrimitive(value));

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const wrap = h("div", { class: "json-node" });

  if (entries.length === 0) {
    wrap.append(h("div", { class: "json-line" }, ...jsonKey(key), h("span", { class: "json-punct" }, open + close)));
    return wrap;
  }

  const caret = h("span", { class: "json-caret" });
  const noun = isArray ? "item" : "key";
  const count = h("span", { class: "json-count" }, `${entries.length} ${noun}${entries.length === 1 ? "" : "s"}`);
  const header = h("div", { class: "json-line json-branch" },
    caret, ...jsonKey(key), h("span", { class: "json-punct" }, open),
    h("span", { class: "json-ellipsis" }, "…"), h("span", { class: "json-punct json-inline-close" }, close), count);
  const children = h("div", { class: "json-children" });
  const closeRow = h("div", { class: "json-line json-close-row" }, h("span", { class: "json-punct" }, close));
  wrap.append(header, children, closeRow);

  // A single .is-open class on the node is the source of truth: CSS drives
  // which parts show (children + closing row vs. the "… } 5 keys" preview).
  let isOpen = false;
  let built = false;
  const set = (openState) => {
    isOpen = openState;
    if (isOpen && !built) {
      for (const [k, v] of entries) children.append(jsonNode(k, v, depth + 1, ctx));
      built = true;
    }
    caret.textContent = isOpen ? "▾" : "▸";
    wrap.classList.toggle("is-open", isOpen);
  };
  header.addEventListener("click", () => set(!isOpen));
  ctx.nodes.push(set);
  set(depth < ctx.autoDepth); // shallow levels start expanded for an at-a-glance overview
  return wrap;
}

function jsonTree(value) {
  const ctx = { nodes: [], autoDepth: 2 };
  const el = h("div", { class: "json-viewer text-xs font-mono" }, jsonNode(null, value, 0, ctx));
  return {
    el,
    // Loop by growing index: opening a node lazy-appends its children's
    // setters to ctx.nodes, and this keeps expanding them too.
    expandAll: () => { for (let i = 0; i < ctx.nodes.length; i++) ctx.nodes[i](true); },
    collapseAll: () => { for (let i = ctx.nodes.length - 1; i >= 0; i--) ctx.nodes[i](i === 0); }, // keep the root open
  };
}

// Shared modal shell: title, subtitle, a right-aligned toolbar of buttons, and
// a body. Only one modal exists at a time (fixed id), so opening a new one
// replaces the last.
function openModal(title, subtitle, toolbar, body) {
  document.getElementById("json-modal")?.remove();
  const dialog = h("dialog", { class: "modal", id: "json-modal" },
    h("div", { class: "modal-box" },
      h("div", { class: "flex items-center gap-3 mb-3 wrap-mobile" },
        h("span", { class: "section-label" }, title),
        subtitle ? h("span", { class: "font-mono text-xs opacity-60" }, subtitle) : null,
        h("div", { class: "flex items-center gap-1 ml-auto" }, ...toolbar),
        h("form", { method: "dialog" }, h("button", { class: "btn btn-xs btn-ghost" }, "✕")),
      ),
      body,
    ),
    // Full-screen click target that closes the dialog — no visible label.
    h("form", { method: "dialog", class: "modal-backdrop" }, h("button", { "aria-label": "close" })),
  );
  document.body.append(dialog);
  dialog.showModal();
}

// JSON inspector (tree ⇄ raw, expand/collapse, copy) — used for the raw
// provider-request payload.
function showJsonModal(title, subtitle, value) {
  const json = JSON.stringify(value, null, 2);
  const tree = jsonTree(value);
  const raw = h("pre", { class: "json-raw text-xs", hidden: true }, json);
  const panel = h("div", { class: "bg-base-100 rounded-box p-4 overflow-auto font-mono", style: "max-height: 70vh" }, tree.el, raw);

  let showRaw = false;
  const rawBtn = h("button", { class: "btn btn-xs" }, "raw");
  rawBtn.addEventListener("click", () => {
    showRaw = !showRaw;
    raw.hidden = !showRaw;
    tree.el.hidden = showRaw;
    rawBtn.textContent = showRaw ? "tree" : "raw";
  });

  openModal(title, subtitle, [
    h("button", { class: "btn btn-xs btn-ghost", title: "expand every node", onclick: () => tree.expandAll() }, "expand"),
    h("button", { class: "btn btn-xs btn-ghost", title: "collapse to the top level", onclick: () => tree.collapseAll() }, "collapse"),
    rawBtn,
    h("button", { class: "btn btn-xs", onclick: () => navigator.clipboard.writeText(json).then(() => toast("Copied.")) }, "copy"),
  ], panel);
}

async function openRequestModal(request) {
  if (!state.activeThread) return; // chip clicked after the thread was cleared
  const entry = await api.get(`/requests/${state.activeThread.id}/${request.id}`).catch((e) => (toast(e.message, true), null));
  if (!entry) return;
  const bytes = fmtBytes(JSON.stringify(entry.payload, null, 2).length);
  showJsonModal("Provider request", `${entry.model} · ${fmtTime(entry.at)} · ${bytes}`, entry.payload);
}

// Args (as a JSON tree) plus the recorded result (raw text, so command output
// and file contents read naturally instead of as an escaped JSON string).
// `result` is undefined when none was recorded (e.g. the turn is still running).
function showToolCallModal(name, args, result) {
  const hasArgs = args && Object.keys(args).length > 0;
  const argsTree = hasArgs ? jsonTree(args) : null;
  const output = result?.output ?? "";
  const resultBlock = result
    ? h("pre", { class: `toolcall-result${result.isError ? " is-error" : ""}` }, output || "(no output)")
    : h("div", { class: "opacity-60 text-xs" }, "No result recorded (turn still running?).");

  const body = h("div", { class: "overflow-auto", style: "max-height: 72vh" },
    hasArgs ? h("div", { class: "section-label mb-1" }, "arguments") : null,
    argsTree ? h("div", { class: "bg-base-100 rounded-box p-3 mb-4 font-mono text-xs" }, argsTree.el) : null,
    h("div", { class: "section-label mb-1" }, result?.isError ? "result · error" : "result"),
    h("div", { class: "bg-base-100 rounded-box p-3 font-mono text-xs" }, resultBlock),
  );

  const toolbar = [];
  if (argsTree) toolbar.push(
    h("button", { class: "btn btn-xs btn-ghost", title: "expand every arg", onclick: () => argsTree.expandAll() }, "expand"),
    h("button", { class: "btn btn-xs btn-ghost", title: "collapse args", onclick: () => argsTree.collapseAll() }, "collapse"),
  );
  if (result) toolbar.push(h("button", { class: "btn btn-xs", onclick: () => navigator.clipboard.writeText(output).then(() => toast("Copied.")) }, "copy result"));

  // Prefix with the same ⚙ the rows use, so the header clearly reads as the
  // tool that ran (not just another section label like ARGUMENTS/RESULT).
  openModal(`⚙ ${name}`, "tool call", toolbar, body);
}

async function openToolCallModal(name, args, callId) {
  // 404 (no result yet) resolves to undefined — the modal still shows the args.
  const result = callId && state.activeThread
    ? await api.get(`/threads/${state.activeThread.id}/toolresult?call=${encodeURIComponent(callId)}`).catch(() => undefined)
    : undefined;
  showToolCallModal(name, args, result);
}

/**
 * What the agent can reach for in this thread — Telegram's /skills, for the
 * thread on screen. Skills are discovered from the workspace's directory, so
 * the workspace read is the answer; the list is exactly what a turn here would
 * be offered, names and one-line descriptions included.
 */
async function openSkillsModal(thread) {
  let workspace;
  try {
    workspace = await withLoading(() => api.get(`/workspaces/${encodeURIComponent(thread.workspace)}`));
  } catch (error) {
    return toast(error.message, true);
  }
  const skills = workspace.skills ?? [];
  const rows = skills.map((skill) =>
    h("div", { class: "skill-row" },
      h("div", { class: "skill-name font-mono" }, skill.name),
      h("div", { class: "skill-desc" }, skill.description),
    ),
  );
  const body = h("div", { class: "overflow-auto", style: "max-height: 72vh" },
    rows.length
      ? h("div", { class: "skill-list" }, rows)
      : h("div", { class: "opacity-60 text-sm" }, `No skills are loaded for ${thread.workspace}.`),
  );
  // A workspace can carry dozens of them, and you open this list looking for
  // one — the filter is the difference between reading and scanning.
  const toolbar = rows.length > 8
    ? [h("input", {
        class: "input input-sm skill-filter",
        type: "search",
        placeholder: "filter",
        "aria-label": "Filter skills",
        oninput: (event) => {
          const needle = event.target.value.trim().toLowerCase();
          rows.forEach((row, index) => {
            const skill = skills[index];
            row.hidden = !!needle && !`${skill.name}\n${skill.description}`.toLowerCase().includes(needle);
          });
        },
      })]
    : [];
  openModal("🧩 skills", `${thread.workspace} · ${skills.length}`, toolbar, body);
}

// Abort the running turn — the dashboard's /stop. The button lives in the
// composer and is shown or hidden by the pane's is-running class, so it never
// needs the whole pane re-rendered to appear.
async function stopTurn(id) {
  let result;
  try {
    result = await api.send("POST", `/threads/${id}/interrupt`, {});
  } catch (error) {
    return toast(error.message, true);
  }
  // "Stopping" rather than "stopped": the abort has to unwind the turn, which
  // settles a moment later as the usual turn-done.
  toast(result.stopped || result.dropped ? "Stopping…" : "Nothing was running.");
}

// Deletion is irreversible (history, request logs, and referenced media all
// go), so it takes two clicks: the first arms the button, the second commits.
// No native confirm() — a modal dialog would block scripted browsers.
function deleteThreadButton(id) {
  let armed;
  const button = h("button", {
    class: "menu-item is-danger",
    title: "delete this thread and all its files (history, requests, media)",
    onclick: () => {
      if (!armed) {
        button.textContent = "Delete — click again";
        button.classList.add("is-armed");
        armed = setTimeout(() => {
          armed = undefined;
          button.textContent = "Delete thread";
          button.classList.remove("is-armed");
        }, 4000);
        return;
      }
      clearTimeout(armed);
      deleteThread(id);
    },
  }, "Delete thread");
  return button;
}

async function deleteThread(id) {
  try {
    await api.send("DELETE", `/threads/${id}`);
  } catch (error) {
    return toast(error.message, true);
  }
  toast("Thread deleted.");
  drafts.clear(id); // nothing left to send it to
  // The thread-deleted broadcast also lands here, but don't depend on the
  // socket being healthy to clear the pane we're looking at.
  if (state.activeThread?.id === id) {
    state.activeThread = null;
    renderThreadPane();
    closePaneMobile();
  }
  refreshThreads();
}

async function sendMessage(event) {
  event.preventDefault();
  const media = event.currentTarget.attachments;
  const input = document.getElementById("composer-text");
  const text = input.value.trim();
  if (!text && !media?.any()) return;
  const threadId = state.activeThread.id;
  input.value = "";
  input.dispatchEvent(new Event("input")); // shrink the grown box back to one row, and drop the draft
  // Optimistic bubble: it stays until the transcript read finds the real one,
  // so a long turn doesn't leave the message you just sent off-screen. The
  // chips stay in the tray until the send lands — a failed one must not take
  // the files with it.
  const attachments = (await media?.refs()) ?? [];
  const message = { role: "user", text: withMediaNotes(text, attachments) };
  const bubble = showOutgoing(message);
  scrollToBottom(); // your own message is always worth following down to
  try {
    const delivered = await api.send("POST", `/threads/${threadId}/message`, { text, attachments });
    // The daemon has now added absolute media paths and any voice transcript.
    // Its activity event usually upgrades this first; the response is the
    // deterministic fallback, and also deduplicates either arrival order.
    bubble.set(delivered.message ?? message.text);
    media?.clear();
  } catch (error) {
    // The send failed — drop the optimistic bubble and restore the draft so it
    // doesn't look delivered. The reader may have moved on while it was in
    // flight, so the text goes back to the thread it was written for; the box
    // is only refilled if it's still that thread's box.
    toast(error.message, true);
    bubble.drop();
    drafts.set(threadId, text);
    const box = document.getElementById("composer-text");
    if (box?.dataset.thread === String(threadId)) {
      box.value = text;
      box.dispatchEvent(new Event("input"));
    }
  }
}

/**
 * The optimistic bubble for a message this page just sent, and the two things
 * that can still happen to it: the daemon's final body arrives, or the send
 * failed and it never existed. Where it goes is the whole point — into the
 * running turn when there is one, so it lands where it was typed rather than
 * above everything the turn has been saying since.
 */
function showOutgoing(message) {
  if (state.liveStartedAt) {
    const item = pushLiveMessage(message);
    return {
      set: (text) => { item.text = text; renderLive(true); },
      drop: () => { state.live = state.live.filter((entry) => entry !== item); renderLive(true); },
    };
  }
  state.pending.push(message);
  renderPending();
  return {
    set: (text) => {
      message.text = text;
      // The activity echo may have arrived first and drawn its own bubble.
      state.pending = state.pending.filter((entry) => entry === message || !entry.activity || !sameMessage(entry, message, MATCH_CHARS));
      renderPending();
    },
    drop: () => {
      state.pending = state.pending.filter((entry) => entry !== message);
      renderPending();
    },
  };
}

/** No page title here: the sidebar already says which view this is, and the
 *  list is the whole page. What's left above the threads is one search row and,
 *  only when there is something to choose between, a line of quiet filters. */
async function viewThreads() {
  await refreshThreads();
  renderedFilters = ""; // the markup below is a fresh DOM — the filters have to be built into it again
  view.replaceChildren(
    h("div", { class: "threads-layout flex gap-4", id: "threads-layout" },
      h("div", { class: "threads-list-col w-72 shrink-0 flex flex-col gap-2" },
        h("div", { class: "threads-toolbar" },
          searchBox(),
          h("button", {
            class: "toolbar-icon",
            id: "filter-toggle",
            title: "filters",
            "aria-label": "Filters",
            "aria-controls": "thread-filters",
            "aria-expanded": "false",
            hidden: true, // renderThreadFilters decides whether there is anything to filter
            onclick: toggleFilters,
            html: FILTER_ICON,
          }),
          h("button", {
            class: "toolbar-icon",
            title: "new thread",
            "aria-label": "New thread",
            onclick: () => { newThreadDialog(); openPaneMobile(); },
            html: PLUS_ICON,
          }),
        ),
        h("div", { class: "threads-filters", id: "thread-filters", hidden: true }),
        h("div", { class: "flex flex-col gap-2 overflow-y-auto thread-scroll", id: "thread-list" }),
      ),
      h("div", { class: "flex-1 min-w-0 flex flex-col bg-base-100 border rounded-box", id: "thread-pane" }),
    ),
  );
  renderThreadList();
  // #/threads/<id> names a thread directly — a reload, a bookmark, a link from
  // the Usage page. It wins over whatever was last open here.
  const requested = location.hash.replace("#/", "").split("/")[1];
  // Arriving with nothing open means you came here to say something. The
  // launcher is the landing page, then — an empty pane whose only offer is a
  // button to the launcher was one click of ceremony in front of every session.
  if (requested || state.activeThread) {
    renderThreadPane();
    // A link to a thread that has since been collected falls back to the
    // launcher rather than to an empty pane.
    if (!(await openThread(requested ?? state.activeThread.id))) newThreadDialog();
    // A URL that names a thread is a request to read it, so on a phone it opens
    // the conversation rather than the list it is buried in. No history entry:
    // this *is* the entry — a back from here belongs to whatever came before
    // eleven, not to a list the reader never saw.
    else if (requested) showPane();
  } else {
    newThreadDialog();
  }
}

// One box, searching titles, conversation names and everything ever said in a
// transcript. Debounced: a keystroke is not worth a round trip, and the server
// answers a query by opening session files.
let searchTimer;
function searchBox() {
  return h("div", { class: "search-field" },
    h("span", { class: "search-glyph", "aria-hidden": "true", html: SEARCH_ICON }),
    h("input", {
      class: "search-input",
      type: "search",
      id: "thread-search",
      placeholder: "Search",
      value: state.query,
      oninput: (event) => {
        state.query = event.target.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refreshThreads, 250);
      },
    }),
  );
}

/**
 * Starting a thread is writing the first message — so the message is the page,
 * not a field on a form. The workspace picker sits under the box as a row of
 * pills (it's a choice between three or four names, not a database), remembers
 * what you chose last, and disappears entirely when there is only one
 * workspace to pick.
 */
/** `preferred` preselects a workspace — how a thread you are reading but cannot
 *  type into hands you a fresh one in the same place. */
function newThreadDialog(preferred) {
  const pane = document.getElementById("thread-pane");
  if (!pane) return;
  const workspaces = state.overview?.workspaces ?? [];
  const previous = state.activeThread;
  stopRecording(); // the pane this replaces may have had one running
  state.activeThread = null;
  renderedThreadId = undefined;
  pane.classList.remove("is-running");
  pane.classList.add("is-composing");

  const remembered = preferred ?? prefs.get("workspace", "");
  let workspace = workspaces.includes(remembered) ? remembered : workspaces[0];

  const text = autoGrow(h("textarea", {
    class: "composer-text new-thread-text",
    placeholder: "What do you need?",
    rows: "3",
    oninput: (event) => { drafts.set(NEW_THREAD_DRAFT, event.target.value); refreshStart(); },
    onkeydown: (event) => {
      if (event.key === "Escape") return cancel();
      if (sendsOnEnter(event)) { event.preventDefault(); start(); }
    },
  }));
  // The launcher is where a session lands, so its box is the one most likely to
  // be half-written when the tab is closed. Same draft treatment as a thread's.
  text.value = drafts.get(NEW_THREAD_DRAFT);

  const picker = h("div", { class: "ws-picker" }, workspaces.map((name) =>
    h("button", {
      type: "button",
      class: `ws-pill${name === workspace ? " is-on" : ""}`,
      "aria-pressed": String(name === workspace),
      onclick: (event) => {
        workspace = name;
        for (const pill of picker.children) pill.classList.toggle("is-on", pill === event.currentTarget);
        text.focus();
      },
    }, name),
  ));

  const startButton = h("button", { class: "btn btn-primary", disabled: true, onclick: () => start() }, "Start");
  const card = h("div", { class: "new-thread-card" });
  // The launcher attaches exactly like a thread's composer does — a first
  // message is as likely to be "look at this" as any later one.
  const media = composerAttachments(NEW_THREAD_DRAFT, { form: card, textarea: text, onChange: () => refreshStart() });
  // No workspace configured yet means there is nowhere to run a turn — the
  // button says so by staying off rather than by swallowing the click.
  const refreshStart = () => { startButton.disabled = (!text.value.trim() && !media.any()) || !workspace || starting; };

  let starting = false;
  async function start() {
    if (starting || (!text.value.trim() && !media.any()) || !workspace) return;
    starting = true;
    startButton.textContent = "Starting…";
    refreshStart();
    const attachments = await media.refs();
    const thread = await api
      .send("POST", "/threads", { workspace, text: text.value.trim(), attachments })
      .catch((error) => (toast(error.message, true), null));
    if (!thread) {
      // Leave the draft (and the tray) exactly where they were — the only copy.
      starting = false;
      startButton.textContent = "Start";
      refreshStart();
      return;
    }
    prefs.set("workspace", workspace);
    drafts.clear(NEW_THREAD_DRAFT); // it's a message now
    media.clear();
    await refreshThreads();
    openThread(thread.id);
  }

  function cancel() {
    // Backing out is a decision about the text too — the draft goes with it.
    drafts.clear(NEW_THREAD_DRAFT);
    media.clear();
    // Back to whatever was open before the launcher took the pane.
    state.activeThread = previous;
    renderThreadPane();
    renderThreadList();
    if (!previous) closePaneMobile();
  }

  card.append(
        h("div", { class: "new-thread-head" },
          backButton(),
          h("h2", { class: "page-title" }, "New thread"),
        ),
        media.tray,
        h("div", { class: "composer-box is-tall" },
          media.attachButton,
          text,
          media.micButton,
        ),
        media.recorderBar,
        workspaces.length > 1
          ? h("div", { class: "new-thread-ws" },
              h("span", { class: "dim-label text-xs" }, "Workspace"),
              picker,
            )
          : h("div", { class: "new-thread-ws" },
              h("span", { class: "dim-label text-xs" }, "Workspace"),
              h("span", { class: "font-mono text-xs text-warning" }, workspace ?? "none configured"),
            ),
        h("div", { class: "new-thread-actions" },
          h("span", { class: "composer-hint" }, "Enter to start · paste or drop to attach"),
          h("button", { class: "btn btn-ghost", type: "button", onclick: cancel }, "Cancel"),
          startButton,
        ),
  );
  pane.replaceChildren(h("div", { class: "new-thread" }, card));
  renderThreadList(); // the list must stop showing a thread as open
  refreshStart(); // a restored draft is already something to start with
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

/* ---------- workspaces view (agent + channels together) ---------- */

const ALL_TOOLS = () => state.overview?.tools ?? ["read", "bash", "edit", "write"];

async function viewWorkspaces() {
  // Scope sequence editors complete against the catalog (models-list datalist)
  // and flag unauthenticated providers; both barely change, so cache them.
  const [config, catalog, auth] = await Promise.all([
    cachedGet("/config"),
    state.catalog ?? api.get("/models").catch(() => []),
    state.auth ?? api.get("/providers").catch(() => []),
  ]);
  state.config = config;
  state.catalog = catalog;
  state.auth = auth;
  const pairing = state.overview?.pairing ?? [];

  const children = [
    pageTitle("Workspaces"),
    modelsDatalist(),
    pairing.length ? pairingPanel(pairing) : null,
    ...Object.entries(state.config.workspaces).map(([name, workspace]) => workspaceCard(name, workspace)),
    h("div", { class: "card bg-base-200 max-w-3xl" },
      h("div", { class: "card-body gap-3" },
        h("h2", { class: "card-title text-base" }, "Add workspace"),
        addWorkspaceForm(),
      ),
    ),
  ];
  view.replaceChildren(...children.filter(Boolean));
}

function pairingPanel(requests) {
  return h("div", { class: "card warn max-w-3xl mb-4" },
    h("div", { class: "card-body gap-2" },
      h("h2", { class: "card-title text-base" }, "Pairing requests", h("span", { class: "badge badge-warning badge-sm" }, requests.length)),
      ...requests.map((request) => {
        const isGroup = request.kind === "group";
        const title = (isGroup ? request.chatTitle : request.name) || (isGroup ? `chat ${request.chatId}` : `user ${request.userId}`);
        const meta = [
          `→ ${request.bot}`,
          isGroup ? `chat ${request.chatId}` : `user ${request.userId}`,
          isGroup && request.name ? `via ${request.name}` : null,
          `${timeAgo(request.createdAt)} ago`,
        ].filter(Boolean);
        return h("div", { class: "flex items-center gap-3 py-1" },
          pairingAvatar(request, title),
          h("div", { class: "flex-1 min-w-0" },
            h("div", { class: "flex items-center gap-2 min-w-0" },
              h("span", { class: "truncate" }, title),
              request.username ? h("span", { class: "text-xs opacity-60 font-mono shrink-0" }, `@${request.username}`) : null,
              // Worth the pixels: the name below is the folded one, and knowing
              // the sender wrote it in lookalike glyphs is most of the decision.
              request.disguised
                ? h("span", { class: "badge badge-warning badge-sm shrink-0", title: "Written in lookalike unicode — shown here folded to plain letters." }, "disguised name")
                : null,
            ),
            h("div", { class: "text-xs opacity-60 font-mono truncate" }, meta.join(" · ")),
          ),
          h("button", { class: "btn btn-success btn-sm", onclick: () => pairingAction(request.id, "approve") }, "Approve"),
          h("button", { class: "btn btn-ghost btn-sm", onclick: () => pairingAction(request.id, "deny") }, "Deny"),
        );
      }),
    ),
  );
}

/** The requester's picture, or their initial when Telegram has none to give. */
function pairingAvatar(request, title) {
  if (request.photo) return h("img", { class: "pair-avatar", src: request.photo, alt: "" });
  const initial = [...title.trim()][0]?.toUpperCase() ?? (request.kind === "group" ? "#" : "?");
  return h("div", { class: "pair-avatar pair-avatar-blank" }, initial);
}

function workspaceCard(name, workspace) {
  return h("div", { class: "card bg-base-200 border mb-6" },
    h("div", { class: "card-body gap-5" },
      // scope-head, not wrap-mobile: wrapping sent "remove workspace" to a line
      // of its own, so a phone spent a whole row on a button nobody presses.
      // The path is what gives way instead — it truncates.
      h("div", { class: "scope-head flex items-center gap-3" },
        h("h2", { class: "display text-xl" }, name),
        h("span", { class: "text-xs opacity-50 font-mono truncate min-w-0" }, workspace.path),
        h("button", { class: "btn btn-ghost btn-xs ml-auto shrink-0 text-error", onclick: () =>
          queueSave((next) => { delete next.workspaces[name]; return next; }, { structural: true }) },
          h("span", { class: "hide-mobile" }, "remove workspace"), h("span", { class: "mobile-only" }, "remove")),
      ),

      // -- channels: how the world reaches this workspace --
      h("div", { class: "flex flex-col gap-3" },
        sectionLabel("Channels"),
        ...(workspace.channels ?? []).map((channel, index) => channelCard(name, channel, index)),
        (workspace.channels ?? []).length === 0
          ? h("div", { class: "text-sm opacity-50" }, "No channels — this workspace is dashboard-only.")
          : null,
        addChannelForm(name),
      ),

      h("div", { class: "divider my-0" }),

      // -- agent settings --
      h("div", { class: "flex flex-col gap-3" },
        sectionLabel("Agent"),
        h("div", { class: "grid-3 gap-4" },
          labeled("Directory", h("input", { class: "input input-sm w-full font-mono", value: workspace.path,
            onchange: (e) => updateWorkspace(name, (ws) => { ws.path = e.target.value; }) })),
          labeled("Tools",
            h("div", { class: "flex flex-wrap gap-3 py-1" },
              ALL_TOOLS().map((tool) => {
                const enabled = !workspace.tools || workspace.tools.includes(tool);
                return h("label", { class: "label cursor-pointer gap-2 text-sm" },
                  h("input", { type: "checkbox", class: "checkbox checkbox-sm", checked: enabled, onchange: (e) => updateWorkspace(name, (ws) => {
                    const current = ws.tools ?? [...ALL_TOOLS()];
                    const next = e.target.checked ? [...new Set([...current, tool])] : current.filter((t) => t !== tool);
                    ws.tools = next.length === ALL_TOOLS().length ? undefined : next;
                  }) }),
                  tool,
                );
              }),
            )),
        ),
        scopeSequenceField(workspace, inheritedSequenceFor(),
          (fn, structural) => updateWorkspace(name, fn, { structural })),
        systemPromptField(name, workspace),
      ),
    ),
  );
}

function channelCard(workspaceName, channel, index) {
  const status = state.overview?.bots?.find((b) => b.name === channel.name);
  // Shallow-patch this channel against the freshest config (in place, no rebuild).
  const save = (patch) => updateWorkspace(workspaceName, (ws) => {
    ws.channels[index] = { ...ws.channels[index], ...patch };
  });
  return h("div", { class: "card bg-base-100 border" },
    h("div", { class: "card-body gap-4 p-4" },
      h("div", { class: "scope-head flex items-center gap-2" },
        h("span", { class: "shrink-0", html: CHANNEL_ICONS[channel.type] ?? "" }),
        h("span", { class: "font-mono font-semibold truncate min-w-0" }, channel.name),
        status?.username
          ? h("a", { class: "text-xs link link-hover opacity-60 hide-mobile", href: `https://t.me/${status.username}`, target: "_blank", rel: "noopener" }, `@${status.username}`)
          : null,
        h("span", { class: `badge badge-sm shrink-0 ${status?.connected ? "badge-success" : "badge-error"} badge-soft ml-2` }, status?.connected ? "polling" : "offline"),
        h("button", { class: "btn btn-ghost btn-xs ml-auto shrink-0 text-error", onclick: () =>
          updateWorkspace(workspaceName, (ws) => { ws.channels = (ws.channels ?? []).filter((_, i) => i !== index); }, { structural: true }) }, "remove"),
      ),
      // No grid here: the two empty cells that used to keep the token in the
      // first third of a grid-3 became two empty *rows* the moment the grid
      // collapsed to one column, which is a finger's worth of blank screen.
      h("div", { class: "field-third" },
        labeled("Bot token", h("input", { type: "password", class: "input input-sm w-full font-mono", value: channel.token,
          onchange: (e) => save({ token: e.target.value }) })),
      ),
      h("div", { class: "flex flex-col gap-2" },
        h("div", { class: "text-xs dim-label flex items-center gap-1.5" }, "Users",
          info("Who can DM this bot. Strangers who message it become pairing requests; names and usernames fill in automatically from traffic.")),
        ...Object.entries(channel.users ?? {}).map(([id, user]) => userRow(workspaceName, index, id, user)),
        h("input", { class: "input input-xs w-40 font-mono", placeholder: "add user by id", onchange: (e) => {
          const id = e.target.value.trim();
          if (/^\d+$/.test(id)) updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[index]; ch.users = { ...ch.users, [id]: {} }; }, { structural: true });
        } }),
      ),
      h("div", { class: "flex flex-col gap-2" },
        h("div", { class: "text-xs dim-label flex items-center gap-1.5" }, "Groups",
          info("Group chats the bot lives in — message it inside a group to register it. Each group (and each forum topic) can append its own instructions to the prompt.")),
        ...Object.entries(channel.groups ?? {}).map(([id, group]) => groupRow(workspaceName, index, id, group)),
        Object.keys(channel.groups ?? {}).length === 0 ? h("span", { class: "text-xs opacity-50" }, "none yet — message the bot in a group to add it") : null,
      ),
    ),
  );
}

/** Workspace-level: choose the built-in personality (shown read-only) or a custom one. */
function systemPromptField(name, workspace) {
  const custom = workspace.systemPrompt != null;
  // Switching built-in/custom swaps which editor renders, so it re-renders;
  // typing in the custom editor updates in place.
  const setPrompt = (value, structural) => updateWorkspace(name, (ws) => { ws.systemPrompt = value; }, { structural });
  // prompt-editor: eight rows of monospace is a third of a phone screen, and
  // CSS cuts it down on a narrow one. It stays draggable either way.
  //
  // On built-in the block is read-only reference — the same text, printed once
  // per workspace, in front of the settings you came for — so it folds. The
  // custom one is the thing being edited and stays open.
  const editor = custom
    ? h("textarea", { class: "textarea prompt-editor w-full font-mono text-xs", rows: "8", placeholder: "your custom personality/style block…",
        onchange: (e) => setPrompt(e.target.value, false) }, workspace.systemPrompt ?? "")
    : disclosure("show the built-in prompt",
        h("textarea", { class: "textarea prompt-editor w-full font-mono text-xs opacity-60", rows: "8", readonly: true },
          state.overview?.builtinSystemPrompt ?? ""));
  return h("div", { class: "flex flex-col gap-2" },
    h("div", { class: "flex items-center gap-4" },
      h("span", { class: "text-xs dim-label flex items-center gap-1.5" }, "System prompt",
        info("The agent's personality and style. Runtime facts (workspace, date, tools) are always appended after it, whether built-in or custom.")),
      h("div", { class: "join ml-auto" },
        h("button", { class: `btn btn-xs join-item ${custom ? "" : "btn-primary"}`, onclick: () => custom && setPrompt(undefined, true) }, "built-in"),
        h("button", { class: `btn btn-xs join-item ${custom ? "btn-primary" : ""}`,
          onclick: () => !custom && setPrompt(state.overview?.builtinSystemPrompt ?? "", true) }, "custom"),
      ),
    ),
    editor,
  );
}

/** The sequence a scope inherits when it doesn't carry its own: the nearest
 * ancestor's, or the global one from the Models page. Call with no arguments
 * for what a workspace inherits. */
function inheritedSequenceFor(workspaceName, owner, ownerSource = "the group") {
  if (owner?.models?.length) return { entries: owner.models, source: ownerSource };
  const workspace = state.config?.workspaces?.[workspaceName];
  if (workspace?.models?.length) return { entries: workspace.models, source: "the workspace" };
  return { entries: state.config?.models ?? [], source: "the Models page" };
}

/** Amber badge on group/topic rows that carry their own model sequence. */
function modelsBadge(scope) {
  if (!scope.models?.length) return null;
  return h("span", {
    class: "badge badge-warning badge-xs badge-soft",
    title: scope.models.map((entry) => entry.model).join(" → "),
  }, "models");
}

/* Scope-level sequence editor (workspace, group, topic). Resting state is a
   one-line summary of what's inherited and from where; "customize" copies that
   sequence into the scope and opens the same editor the Models page uses, so
   every knob (order, reasoning, tools) is available per scope. */
function scopeSequenceField(scope, inherited, mutateScope) {
  const overridden = !!scope.models?.length;
  const header = h("div", { class: "flex items-center gap-2" },
    h("span", { class: "text-xs dim-label flex items-center gap-1.5" }, "Models",
      info("The model sequence for turns in this scope: the first entry leads, the rest are fallbacks — each with its own reasoning and tools. Customizing copies the inherited sequence here; removing every entry goes back to inheriting.")),
    h("div", { class: "ml-auto" },
      overridden
        ? h("button", { class: "btn btn-xs btn-ghost", onclick: () => mutateScope((s) => { delete s.models; }, true) }, "revert to inherited")
        : h("button", { class: "btn btn-xs", onclick: () =>
            mutateScope((s) => { s.models = structuredClone(inherited.entries); }, true) }, "customize"),
    ),
  );
  if (!overridden) {
    const summary = inherited.entries.map((entry) => entry.model).join(" → ") || "none configured";
    return h("div", { class: "flex flex-col gap-1" },
      header,
      h("div", { class: "font-mono text-xs opacity-50 truncate" }, `${summary} · from ${inherited.source}`),
    );
  }
  const ops = sequenceOps(mutateScope, { emptyMeansInherit: true });
  return h("div", { class: "flex flex-col gap-2" },
    header,
    sequenceEditor(scope.models, ops, { compact: true }),
  );
}

/** Group/topic-level: only an append. */
function appendField(value, onchange) {
  return labeled("Append to system prompt",
    h("textarea", { class: "textarea w-full font-mono text-xs", rows: "3",
      onchange: (e) => onchange(e.target.value.trim() || undefined) }, value ?? ""),
    "Extra instructions added at the end of the system prompt, only for this scope.");
}

/**
 * The topics of whatever owns them — a group, or a person, since a bot with
 * topic mode enabled has topics in its DMs too. `select` picks the owner out of
 * a draft config so the same editor can write to either place.
 * Adding/removing a topic changes the rendered rows, so those re-render;
 * editing a topic's title or prompt updates in place.
 */
function topicsSection(workspaceName, owner, inherited, select) {
  const patchTopic = (topicId, patch, structural = false) =>
    updateWorkspace(workspaceName, (ws) => {
      const target = select(ws);
      const topics = { ...target.topics };
      if (patch === null) delete topics[topicId];
      else topics[topicId] = { ...topics[topicId], ...patch };
      target.topics = Object.keys(topics).length ? topics : undefined;
    }, { structural });
  return [
    h("div", { class: "text-xs dim-label mt-1 flex items-center gap-1.5" }, "Topics",
      info("Each topic gets its own thread and can append its own instructions. Topics register themselves when someone first speaks in them — in a forum group, or in the DM of a bot with topic mode enabled.")),
    ...Object.entries(owner.topics ?? {}).map(([topicId, topic]) =>
      h("div", { class: "border border-base-300 rounded-box p-3 flex flex-col gap-2" },
        h("div", { class: "topic-head flex items-center gap-2" },
          h("input", { class: "input input-xs w-44", value: topic.title ?? "", placeholder: "topic name (optional)",
            onchange: (e) => patchTopic(topicId, { title: e.target.value.trim() || undefined }) }),
          h("span", { class: "font-mono text-xs opacity-50" }, `topic ${topicId}`),
          topic.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
          modelsBadge(topic),
          h("button", { class: "btn btn-ghost btn-xs text-error ml-auto", onclick: () => patchTopic(topicId, null, true) }, "remove"),
        ),
        scopeSequenceField(topic, inherited,
          (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(select(ws).topics[topicId]), { structural })),
        appendField(topic.appendSystemPrompt, (v) => patchTopic(topicId, { appendSystemPrompt: v })),
      ),
    ),
    h("input", { class: "input input-xs w-44 font-mono", placeholder: "add topic by id", onchange: (e) => {
      const topicId = e.target.value.trim();
      if (/^\d+$/.test(topicId)) patchTopic(topicId, {}, true);
    } }),
  ];
}

function userRow(workspaceName, chIndex, id, user) {
  const patchUser = (patch) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.users = { ...ch.users, [id]: { ...ch.users?.[id], ...patch } };
  });
  return h("div", { class: "collapse collapse-arrow bg-base-200 border", "data-collapse": `user:${workspaceName}:${chIndex}:${id}` },
    h("input", { type: "checkbox" }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold" }, user.name ?? id),
      user.username ? h("span", { class: "text-xs opacity-50" }, `@${user.username}`) : null,
      h("span", { class: "font-mono text-xs opacity-50" }, id),
      user.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
      modelsBadge(user),
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      scopeSequenceField(user, inheritedSequenceFor(workspaceName),
        (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(ws.channels[chIndex].users[id]), { structural })),
      appendField(user.appendSystemPrompt, (v) => patchUser({ appendSystemPrompt: v })),
      ...topicsSection(workspaceName, user, inheritedSequenceFor(workspaceName, user, "the DM"), (ws) => ws.channels[chIndex].users[id]),
      h("button", { class: "btn btn-ghost btn-xs self-start text-error", onclick: () =>
        updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const users = { ...ch.users }; delete users[id]; ch.users = users; }, { structural: true }) }, "remove user"),
    ),
  );
}

function groupRow(workspaceName, chIndex, id, group) {
  const patchGroup = (patch, opts) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.groups = { ...ch.groups, [id]: { ...ch.groups?.[id], ...patch } };
  }, opts);
  return h("div", { class: "collapse collapse-arrow bg-base-200 border", "data-collapse": `group:${workspaceName}:${chIndex}:${id}` },
    h("input", { type: "checkbox" }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold" }, group.title ?? id),
      h("span", { class: "font-mono text-xs opacity-50" }, id),
      group.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
      modelsBadge(group),
      // Hidden on a phone: it is a setting, and the row that carries it already
      // has a name, an id and two badges fighting over 300 pixels. Open the row
      // and the toggle it describes is the first thing in there.
      h("span", { class: "text-xs opacity-50 ml-auto mr-2 hide-mobile" }, group.requireMention === false ? "replies freely" : "@mention required"),
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      h("div", { class: "flex items-center gap-4" },
        h("label", { class: "label cursor-pointer gap-2 text-sm" },
          h("input", { type: "checkbox", class: "toggle toggle-sm", checked: group.requireMention !== false,
            onchange: (e) => patchGroup({ requireMention: e.target.checked ? undefined : false }) }),
          "require @mention",
        ),
        h("button", { class: "btn btn-ghost btn-xs text-error ml-auto", onclick: () =>
          updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const groups = { ...ch.groups }; delete groups[id]; ch.groups = groups; }, { structural: true }) }, "remove group"),
      ),
      scopeSequenceField(group, inheritedSequenceFor(workspaceName),
        (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(ws.channels[chIndex].groups[id]), { structural })),
      appendField(group.appendSystemPrompt, (v) => patchGroup({ appendSystemPrompt: v })),
      ...topicsSection(workspaceName, group, inheritedSequenceFor(workspaceName, group), (ws) => ws.channels[chIndex].groups[id]),
    ),
  );
}

function addChannelForm(workspaceName) {
  const types = state.overview?.channelTypes ?? ["telegram"];
  const type = h("select", { class: "select select-sm w-32" }, types.map((t) => h("option", { value: t }, t)));
  const name = h("input", { class: "input input-sm w-28 font-mono", placeholder: "name" });
  const token = h("input", { class: "input input-sm flex-1 font-mono", placeholder: "bot token from @BotFather" });
  return disclosure("Add channel",
    h("div", { class: "flex gap-2 items-center stack-mobile" },
      type, name, token,
      h("button", { class: "btn btn-sm", onclick: () => {
        if (!name.value.trim() || !token.value.trim()) return;
        return updateWorkspace(workspaceName, (ws) => {
          ws.channels = [...(ws.channels ?? []), { type: type.value, name: name.value.trim(), token: token.value.trim(), users: {} }];
        }, { structural: true });
      } }, "Add"),
    ),
  );
}

/**
 * A form that is not what the page is about, folded away until it is.
 *
 * This one appears once per workspace and is four empty fields each; on a phone
 * that is most of a screen, repeated, in front of the channels you came to
 * look at. On a desktop it is merely noise, which is why the fold is not
 * mobile-only.
 */
const disclosure = (label, ...children) =>
  h("details", { class: "disclosure" }, h("summary", {}, label), ...children);

function addWorkspaceForm() {
  const name = h("input", { class: "input input-sm w-36 font-mono", placeholder: "name" });
  const path = h("input", { class: "input input-sm flex-1 font-mono", placeholder: "~/path/to/directory" });
  return h("div", { class: "flex gap-2 stack-mobile" }, name, path,
    h("button", { class: "btn btn-sm btn-primary", onclick: () => {
      if (!name.value.trim() || !path.value.trim()) return;
      queueSave((next) => { next.workspaces[name.value.trim()] = { path: path.value.trim() }; return next; }, { structural: true });
    } }, "Add"),
  );
}

// Config writes are serialized so rapid field edits compose on fresh state
// instead of racing — each save clones the latest state.config at the moment
// it runs, not when the handler fired. This lets field edits update in place
// without tearing down the view (which lost focus, scroll, and open panels).
// `structural: true` re-renders after the save (the set of rendered rows
// changed); field edits leave the DOM alone. Errors are toasted, never thrown.
let saveChain = Promise.resolve();
// A local save echoes back as a `config-changed` broadcast; while any save of
// ours is in flight, onConfigChanged ignores that echo instead of rebuilding
// the view mid-edit.
let savesInFlight = 0;

function queueSave(build, { structural = false } = {}) {
  savesInFlight++;
  const run = saveChain
    .then(async () => {
      const next = build(structuredClone(state.config));
      state.config = await api.send("PUT", "/config", next);
      // The save's own answer is the freshest config there is; the overview
      // describes the same file, so it has to go.
      seedCache("/config", state.config);
      invalidate("/overview");
      toast("Saved — applied live.");
      if (structural) await render();
    })
    .catch((error) => toast(error.message, true))
    .finally(() => savesInFlight--);
  saveChain = run; // never rejects, so the chain survives a failed save
  return run;
}

/** Mutate one workspace in place against the freshest config, then persist. */
function updateWorkspace(name, mutate, opts) {
  return queueSave((next) => {
    mutate(next.workspaces[name], next);
    return next;
  }, opts);
}

async function pairingAction(code, action) {
  try {
    await api.send("POST", `/pairing/${code}/${action}`);
    toast(action === "approve" ? "Paired." : "Request denied.");
  } catch (error) {
    toast(error.message, true);
  }
  invalidate("/overview"); // the queue this request was in just changed
  render(); // re-reads /overview and repaints the badge — no separate fetch needed
}

/* ---------- models view (the sequence) ---------- */

const fmtContext = (tokens) =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}k`;

const REASONING_LEVELS = () => state.overview?.reasoningLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh"];

function modelsDatalist() {
  return h("datalist", { id: "models-list" }, (state.catalog ?? []).map((m) => h("option", { value: m.ref })));
}

/** One usage window as a thin meter: how much of the quota is already burned. */
function usageMeter(window) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const level = used >= 90 ? "crit" : used >= 65 ? "warn" : "";
  const reset = window.resetAt ? ` · resets ${timeUntil(window.resetAt)}` : "";
  return h("div", { class: "flex items-center gap-2 text-xs" },
    h("span", { class: "usage-label" }, window.label),
    window.unlimited
      ? h("span", { class: "opacity-60" }, "unlimited")
      : h("div", { class: `meter ${level}` }, h("i", { style: `width:${used}%` })),
    window.unlimited ? null : h("span", { class: "opacity-60", style: "white-space:nowrap" }, `${Math.round(100 - used)}% left${reset}`),
  );
}

function timeUntil(ts) {
  const minutes = Math.max(0, Math.ceil((ts - Date.now()) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days) return `in ${days}d ${hours}h`;
  if (hours) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

/** Fill each provider card's usage slot once /usage answers. The server hits
 * each provider's quota API for it, so reuse recent reports across the
 * re-renders every structural edit triggers. */
const USAGE_TTL_MS = 60_000;
let usageCache = { at: 0, reports: null };
async function loadUsage() {
  if (!usageCache.reports || Date.now() - usageCache.at > USAGE_TTL_MS) {
    usageCache = { at: Date.now(), reports: await api.get("/usage").catch(() => []) };
  }
  const { reports } = usageCache;
  for (const slot of document.querySelectorAll("[data-usage-provider]")) {
    const report = reports.find((r) => r.provider === slot.dataset.usageProvider);
    slot.replaceChildren();
    if (!report) continue;
    if (report.unsupported) {
      // A provider billed per use has no quota to report, and saying so is only
      // worth the room where the provider itself is the subject. Anywhere the
      // slot is marked optional (the Usage page's strip), the row just goes.
      const optional = slot.closest("[data-usage-optional]");
      if (optional) optional.remove();
      else slot.append(h("div", { class: "text-xs opacity-40" }, "this provider doesn't report subscription usage"));
      continue;
    }
    if (report.error) {
      slot.append(h("div", { class: "text-xs text-error opacity-60" }, `usage unavailable — ${report.error}`));
      continue;
    }
    const { usage } = report;
    for (const window of usage.windows) slot.append(usageMeter(window));
    if (usage.credits !== undefined) slot.append(h("div", { class: "text-xs opacity-60" }, `${usage.credits.toLocaleString()} credits left`));
    for (const fact of usage.facts ?? []) slot.append(h("div", { class: "text-xs opacity-60" }, `${fact.label}: ${fact.value}`));
    // The plan lands in the card header, next to the provider's name.
    const plan = document.querySelector(`[data-usage-plan="${report.provider}"]`);
    if (plan && usage.plan) plan.textContent = `${usage.provider} · ${usage.plan}`;
  }
  // A strip whose every row turned out to have no quota is a heading over
  // nothing: it goes too.
  for (const section of document.querySelectorAll("[data-usage-strip]")) {
    if (!section.querySelector("[data-usage-optional]")) section.remove();
  }
}

const PROVIDER_LOGIN_HINTS = { "claude-code": "run `claude auth login`" };

/** One provider the sequences rely on: identity, credentials, live quota. */
function providerCard(provider) {
  const authEntry = (state.auth ?? []).find((a) => a.provider === provider);
  const configured = authEntry?.configured;
  return h("div", { class: "card bg-base-200 border" },
    h("div", { class: "card-body gap-2 p-4" },
      h("div", { class: "flex items-center gap-2 wrap-mobile" },
        h("span", { class: "font-mono font-semibold" }, provider),
        configured
          ? h("span", { class: "badge badge-success badge-xs badge-soft" },
              `✓ ${authEntry.label ?? AUTH_SOURCE_LABELS[authEntry.source] ?? authEntry.source ?? "authenticated"}`)
          : h("span", { class: "badge badge-error badge-xs badge-soft" }, "not authenticated"),
        h("span", { class: "text-xs opacity-50 ml-auto", "data-usage-plan": provider }),
      ),
      configured
        ? h("div", { class: "flex flex-col gap-1.5", "data-usage-provider": provider },
            h("div", { class: "text-xs opacity-40" }, "checking usage…"))
        : h("div", { class: "text-xs opacity-60" }, `No credentials — ${PROVIDER_LOGIN_HINTS[provider] ?? "run `pi` and `/login`"}.`),
    ),
  );
}

// pi's credential-source ids, translated to where the login actually lives.
const AUTH_SOURCE_LABELS = { stored: "pi login", environment: "external login", runtime: "runtime key" };

/** The four sequence mutations, routed through whichever save channel owns the
 * models array. `withModels(fn, structural)` runs fn(owner) where owner.models
 * is the sequence; `emptyMeansInherit` drops the array when the last entry
 * goes (scope overrides revert to inheriting; the global sequence keeps []). */
function sequenceOps(withModels, { emptyMeansInherit = false } = {}) {
  return {
    move: (index, delta) => withModels((owner) => {
      const [step] = owner.models.splice(index, 1);
      owner.models.splice(index + delta, 0, step);
    }, true),
    patch: (index, mutate, structural = false) => withModels((owner) => mutate(owner.models[index]), structural),
    remove: (index) => withModels((owner) => {
      owner.models.splice(index, 1);
      if (emptyMeansInherit && !owner.models.length) delete owner.models;
    }, true),
    add: (ref) => withModels((owner) => { owner.models = [...(owner.models ?? []), { model: ref }]; }, true),
  };
}

/** One step of a sequence: a card hanging on the wire. `ops` routes edits to
 * whichever sequence this card belongs to (global or a scope's). */
function modelCard(entry, index, total, ops, opts = {}) {
  const meta = (state.catalog ?? []).find((m) => m.ref === entry.model);
  const canReason = meta ? meta.reasoning : true;
  const supported = meta?.tools ?? ALL_TOOLS();
  const provider = entry.model.split("/")[0];
  const authEntry = (state.auth ?? []).find((a) => a.provider === provider);
  const defaultReasoning = state.overview?.defaultReasoning ?? "high";

  return h("div", { class: "chain-step" },
    h("div", { class: `chain-node ${index === 0 ? "is-lead" : ""}` }, String(index + 1)),
    h("div", { class: `card ${opts.compact ? "bg-base-100" : "bg-base-200"} border` },
      h("div", { class: `card-body gap-3 ${opts.compact ? "p-3" : "p-4"}` },
        h("div", { class: "flex items-center gap-2 wrap-mobile" },
          h("span", { class: "chain-role" }, index === 0 ? "leads every turn" : "fallback"),
          !meta ? h("span", { class: "badge badge-error badge-xs badge-soft", title: "not in pi's model registry" }, "unknown model") : null,
          meta && authEntry && !authEntry.configured
            ? h("span", { class: "badge badge-error badge-xs badge-soft", title: "no credentials for this provider" }, "no auth")
            : null,
          h("div", { class: "flex items-center gap-1 ml-auto" },
            h("button", { class: "btn btn-ghost btn-xs", disabled: index === 0, "aria-label": "move up", onclick: () => ops.move(index, -1) }, "↑"),
            h("button", { class: "btn btn-ghost btn-xs", disabled: index === total - 1, "aria-label": "move down", onclick: () => ops.move(index, 1) }, "↓"),
            h("button", { class: "btn btn-ghost btn-xs text-error", onclick: () => ops.remove(index) }, "remove"),
          ),
        ),
        h("div", { class: "grid-2 gap-4" },
          labeled("Model", h("input", { class: "input input-sm w-full font-mono", value: entry.model, list: "models-list",
            onchange: (e) => { const v = e.target.value.trim(); if (v) ops.patch(index, (m) => { m.model = v; }, true); } })),
          labeled("Reasoning",
            canReason
              ? h("select", { class: "select select-sm w-full", onchange: (e) => ops.patch(index, (m) => { m.reasoning = e.target.value === defaultReasoning ? undefined : e.target.value; }) },
                  REASONING_LEVELS().map((level) => h("option", { value: level, selected: (entry.reasoning ?? defaultReasoning) === level }, level)))
              : h("div", { class: "text-sm opacity-50", style: "padding:0.3rem 0" }, "not a reasoning model"),
            canReason ? "Thinking effort while this model drives a turn." : undefined),
        ),
        labeled("Tools",
          h("div", { class: "flex flex-wrap gap-3 py-1" },
            supported.map((tool) => {
              const enabled = !entry.tools || entry.tools.includes(tool);
              return h("label", { class: "label cursor-pointer gap-2 text-sm" },
                h("input", { type: "checkbox", class: "checkbox checkbox-sm", checked: enabled, onchange: (e) => ops.patch(index, (m) => {
                  const current = m.tools ?? [...supported];
                  const next = e.target.checked ? [...new Set([...current, tool])] : current.filter((t) => t !== tool);
                  m.tools = next.length >= supported.length ? undefined : next;
                }) }),
                tool,
              );
            }),
          ),
          "Only tools this model's runtime actually has are listed. A workspace's own tool limits still apply on top."),
        meta
          ? h("div", { class: "text-xs opacity-50 font-mono flex items-center gap-3 flex-wrap" },
              h("span", {}, meta.name),
              h("span", {}, `${fmtContext(meta.contextWindow)} context`),
            )
          : null,
      ),
    ),
  );
}

/** A full sequence editor: the chain of cards plus the add-model row. */
function sequenceEditor(models, ops, opts = {}) {
  const addInput = h("input", { class: "input input-sm w-72 font-mono", list: "models-list",
    placeholder: models.length ? "add a fallback model" : "provider/model-id" });
  const add = () => {
    const value = addInput.value.trim();
    if (value) ops.add(value);
  };
  return h("div", { class: "flex flex-col gap-4" },
    models.length ? h("div", { class: "chain" }, models.map((entry, index) => modelCard(entry, index, models.length, ops, opts))) : null,
    h("div", { class: "flex gap-2 items-center stack-mobile", style: "padding-left: 2.4rem" },
      addInput,
      h("button", { class: "btn btn-sm btn-primary", onclick: add }, "Add"),
    ),
  );
}

async function viewModels() {
  // The catalog and auth statuses barely change — fetch them once per session,
  // not on every structural re-render.
  const [config, catalog, auth] = await Promise.all([
    cachedGet("/config"),
    state.catalog ?? api.get("/models"),
    state.auth ?? api.get("/providers"),
  ]);
  state.config = config;
  state.catalog = catalog;
  state.auth = auth;
  const models = config.models ?? [];

  const ops = sequenceOps((fn, structural) => queueSave((next) => { fn(next); return next; }, { structural }));

  view.replaceChildren(
    pageTitle("Models"),
    modelsDatalist(),
    h("div", { class: "max-w-3xl flex flex-col gap-4" },
      h("p", { class: "text-sm opacity-60", style: "max-width: 40rem" },
        "Every turn starts on the first model. When it fails, the turn retries down the wire — same conversation, next model. Workspaces, groups and topics can carry their own sequence instead of this one."),
      models.length === 0 ? h("div", { class: "alert" }, "No models yet — add one below to bring eleven to life.") : null,
      sequenceEditor(models, ops),
      providersSection(),
    ),
  );
  void loadUsage();
}

/** Every provider referenced by any sequence (global, workspace, group or
 * topic) — derived from the config the page already holds, so it can't drift
 * from what the cards below show. */
function providersInUse() {
  const refs = [];
  const scope = (s) => {
    for (const entry of s?.models ?? []) refs.push(entry.model);
  };
  scope(state.config);
  for (const workspace of Object.values(state.config?.workspaces ?? {})) {
    scope(workspace);
    for (const channel of workspace.channels ?? []) {
      for (const owner of [...Object.values(channel.groups ?? {}), ...Object.values(channel.users ?? {})]) {
        scope(owner);
        for (const topic of Object.values(owner.topics ?? {})) scope(topic);
      }
    }
  }
  return [...new Set(refs.map((ref) => ref.split("/")[0]).filter(Boolean))].sort();
}

/** Auth + subscription usage live per provider, not per model — so they get
 * their own section: rich cards for the providers the sequences actually use,
 * the rest tucked into a quiet disclosure. */
function providersSection() {
  const inUse = providersInUse();
  const others = (state.auth ?? []).filter((entry) => !inUse.includes(entry.provider));
  return h("div", { class: "flex flex-col gap-3 mt-4" },
    sectionLabel("Providers"),
    inUse.length === 0 ? h("div", { class: "text-sm opacity-50" }, "No providers in use yet — they show up here once a model is added.") : null,
    ...inUse.map((provider) => providerCard(provider)),
    others.length
      ? h("div", { class: "collapse collapse-arrow bg-base-200 border", "data-collapse": "providers:others" },
          h("input", { type: "checkbox" }),
          h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
            h("span", { class: "opacity-60" }, "Other providers"),
            h("span", { class: "badge badge-ghost badge-xs" }, String(others.length)),
            h("span", { class: "text-xs opacity-40 ml-auto mr-2" }, `${others.filter((entry) => entry.configured).length} authenticated`),
          ),
          h("div", { class: "collapse-content flex flex-col gap-1" },
            h("p", { class: "text-xs opacity-50" }, "Every provider pi knows. Authenticate with `pi` and `/login` (or keys in ~/.pi/agent/auth.json); Claude Code uses `claude auth login`."),
            ...others.map((entry) =>
              h("div", { class: "flex items-center gap-2 font-mono text-xs py-1" },
                h("span", {}, entry.provider),
                entry.configured
                  ? h("span", { class: "text-success" }, `✓ ${entry.label ?? AUTH_SOURCE_LABELS[entry.source] ?? entry.source ?? "authenticated"}`)
                  : h("span", { class: "opacity-40" }, "—"),
              ),
            ),
          ),
        )
      : null,
  );
}

/* ---------- usage view (what the quotas were spent on) ---------- */

/** Windows the page offers. 90 days is deliberately past the default retention:
 *  asking for it is how you find out how far back the files actually go. */
const USAGE_WINDOWS = [7, 30, 90];
/** How many models the chart gives a colour of their own. */
const SERIES_COLORS = 5;

const tokensOf = (bucket) => bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
const promptOf = (bucket) => bucket.input + bucket.cacheRead + bucket.cacheWrite;

/** Token counts run to ten digits here, and nobody reads ten digits. */
function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

const fmtMoney = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const fmtPercent = (ratio) => `${Math.round(ratio * 100)}%`;
const modelLabel = (model) => model || "compaction";

function usageDays() {
  const stored = Number(prefs.get("usage.days", "30"));
  return USAGE_WINDOWS.includes(stored) ? stored : 30;
}

async function viewUsage() {
  const days = usageDays();
  // /config is what the quota strip derives its provider list from, and it's
  // cached — so switching windows costs one request, not two.
  const [report, config] = await Promise.all([api.get(`/usage/tokens?days=${days}`), cachedGet("/config")]);
  state.config = config;

  // Chart and legend agree on colour by sharing one ordering: byModel arrives
  // sorted by spend, so the biggest series is always series-0.
  const series = report.byModel.map((entry) => entry.model);

  view.replaceChildren(
    pageTitle("Usage",
      h("div", { class: "join ml-auto" }, USAGE_WINDOWS.map((option) =>
        h("button", {
          class: `btn btn-sm join-item${option === days ? " btn-primary" : ""}`,
          onclick: () => { prefs.set("usage.days", String(option)); void render(); },
        }, `${option}d`)))),
    // No blurb under the title: the tiles name themselves, and the line at the
    // bottom of the page says where the numbers come from.
    h("div", { class: "flex flex-col gap-5" },
      report.total.responses === 0
        ? h("div", { class: "alert" }, "Nothing billed in this window. No turns ran, or their transcripts are gone.")
        : h("div", { class: "flex flex-col gap-5" },
            usageTiles(report),
            coldCacheNote(report),
            usageChartSection(report, series),
            usageModelsTable(report, series),
            usageThreadsTable(report),
          ),
      usageQuotaSection(),
      usageCoverage(report, days),
    ),
  );
  void loadUsage();
}

/** The four numbers worth having before any breakdown. */
function usageTiles(report) {
  const { total } = report;
  const prompt = promptOf(total);
  const hit = prompt ? total.cacheRead / prompt : 0;
  return h("div", { class: "usage-tiles" },
    usageTile("Prompt", fmtTokens(prompt),
      `${fmtTokens(total.input)} fresh · ${fmtTokens(total.cacheRead)} cached · ${fmtTokens(total.cacheWrite)} written`),
    usageTile("Output", fmtTokens(total.output),
      `${fmtTokens(total.reasoning)} reasoning · ${total.responses.toLocaleString()} responses`),
    usageTile("Cache hit", fmtPercent(hit), "prompt tokens served from cache",
      hit >= 0.9 ? "good" : hit >= 0.7 ? "warn" : "bad"),
    // Whether this is money or only weight depends on how the providers are
    // paid for, and eleven has no way to know. So it says what the number is
    // and lets the reader place it.
    usageTile("List price", fmtMoney(total.cost), "at each provider's published rates"),
  );
}

function usageTile(label, value, hint, tone) {
  return h("div", { class: `usage-tile${tone ? ` is-${tone}` : ""}` },
    h("div", { class: "text-xs dim-label" }, label),
    h("div", { class: "usage-tile-value" }, value),
    h("div", { class: "text-xs opacity-40" }, hint),
  );
}

/** The one actionable line on the page: prompt tokens a warm cache would have
 *  served, and what took the warmth away. */
function coldCacheNote(report) {
  const { waste, total } = report;
  if (!waste.coldResponses) return null;
  const prompt = promptOf(total);
  const share = prompt ? waste.coldTokens / prompt : 0;
  const causes = [
    waste.idleResponses ? `${waste.idleResponses} idle over 5 min` : null,
    waste.modelSwitchResponses ? `${waste.modelSwitchResponses} on a model switch` : null,
  ].filter(Boolean).join(", ");
  return h("div", { class: "text-sm opacity-60" },
    h("span", { class: share > 0.1 ? "text-warning" : "" }, `${fmtTokens(waste.coldTokens)} cold prompt tokens`),
    ` (${fmtPercent(share)}) over ${waste.coldResponses} responses: ${causes}. `,
    info("Cold means the response before it was over 5 minutes old, past the cache TTL, or ran on another model. Only those two causes are counted, so this is a floor."),
  );
}

function usageChartSection(report, series) {
  const max = Math.max(...report.byDay.map((day) => tokensOf(day.total)), 1);
  // A label under every column is unreadable past a fortnight.
  const step = Math.ceil(report.byDay.length / 12);
  return h("div", { class: "flex flex-col gap-2" },
    sectionLabel("Per day"),
    h("div", { class: "usage-chart" }, report.byDay.map((day, index) =>
      h("div", { class: "usage-col" },
        h("div", {
          class: "usage-stack",
          style: `height:${(tokensOf(day.total) / max) * 100}%`,
          title: `${day.day} · ${fmtTokens(tokensOf(day.total))} tokens · ${fmtMoney(day.total.cost)}`,
        }, series.map((model, rank) => {
          const bucket = day.byModel[model];
          if (!bucket) return null;
          return h("i", {
            class: `series-${Math.min(rank, SERIES_COLORS - 1)}`,
            style: `height:${(tokensOf(bucket) / tokensOf(day.total)) * 100}%`,
          });
        })),
        h("div", { class: "usage-xlabel" }, index % step === 0 ? day.day.slice(5) : ""),
      ))),
  );
}

function usageModelsTable(report, series) {
  return h("div", { class: "flex flex-col gap-2" },
    sectionLabel("By model"),
    h("div", { class: "usage-scroll" }, h("table", { class: "table table-sm" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Model"), h("th", {}, "Responses"), h("th", {}, "Prompt"),
        h("th", {}, "Output"), h("th", {}, "Cache hit"), h("th", {}, "List price"))),
      h("tbody", {}, report.byModel.map(({ model, bucket }, rank) => {
        const prompt = promptOf(bucket);
        return h("tr", {},
          h("td", { class: "font-mono text-xs" },
            h("span", { class: `series-swatch series-${Math.min(series.indexOf(model), SERIES_COLORS - 1)}` }),
            modelLabel(model)),
          h("td", {}, bucket.responses.toLocaleString()),
          h("td", {}, fmtTokens(prompt)),
          h("td", {}, fmtTokens(bucket.output)),
          h("td", {}, prompt ? fmtPercent(bucket.cacheRead / prompt) : "—"),
          h("td", {}, fmtMoney(bucket.cost)),
        );
      })),
    )),
    report.compaction.responses
      ? h("div", { class: "text-xs opacity-40" },
          `compaction: ${report.compaction.responses} summarization calls the threads paid to keep going.`)
      : null,
  );
}

function usageThreadsTable(report) {
  if (!report.byThread.length) return null;
  return h("div", { class: "flex flex-col gap-2" },
    sectionLabel("Where it went"),
    h("div", { class: "usage-scroll" }, h("table", { class: "table table-sm" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Thread"), h("th", {}, "Workspace"), h("th", {}, "Tokens"), h("th", {}, "List price"), h("th", {}, "Last model"))),
      h("tbody", {}, report.byThread.map((thread) =>
        h("tr", {},
          h("td", {}, h("a", {
            class: "link link-hover usage-thread",
            href: `#/threads/${thread.id}`,
            title: thread.title ?? thread.conversation ?? thread.id,
          }, thread.title ?? thread.conversation ?? thread.id.slice(0, 8))),
          h("td", { class: "text-warning text-xs" }, thread.workspace),
          h("td", {}, fmtTokens(tokensOf(thread))),
          h("td", {}, fmtMoney(thread.cost)),
          h("td", { class: "font-mono text-xs opacity-60" }, modelLabel(thread.lastModel)),
        ))),
    )),
  );
}

/** The same quota meters the Models page carries, mirrored here so one screen
 *  answers both halves of the question: what was spent, and what is left.
 *
 *  Only the second half is optional — a provider billed per use has no window
 *  to run out of — so every row here is provisional until /usage answers, and
 *  loadUsage drops the ones (and the strip) that turn out to have nothing. */
function usageQuotaSection() {
  const providers = providersInUse();
  if (!providers.length) return null;
  return h("div", { class: "flex flex-col gap-2", "data-usage-strip": true },
    sectionLabel("Quota left"),
    ...providers.map((provider) =>
      h("div", { class: "flex flex-col gap-1.5 py-1", "data-usage-optional": true },
        h("div", { class: "flex items-center gap-2" },
          h("span", { class: "font-mono text-sm" }, provider),
          h("span", { class: "text-xs opacity-50", "data-usage-plan": provider }),
        ),
        h("div", { class: "flex flex-col gap-1.5", "data-usage-provider": provider },
          h("div", { class: "text-xs opacity-40" }, "checking usage…")),
      )),
  );
}

/** Where the data actually begins, which is not where the window does: gc
 *  deletes session files on a retention timer, and what it took with it cannot
 *  be counted. Saying so beats a chart that quietly flattens. */
function usageCoverage(report, days) {
  const parts = [`${report.threads} thread${report.threads === 1 ? "" : "s"}`, `${days} days`];
  if (report.oldestAt !== undefined) {
    const oldest = new Date(report.oldestAt).toLocaleDateString();
    parts.push(report.oldestAt > report.since ? `on disk since ${oldest}, older collected` : `on disk since ${oldest}`);
  }
  return h("div", { class: "text-xs opacity-40", title: `window starts ${new Date(report.since).toLocaleString()}` },
    parts.join(" · "));
}

/* ---------- settings view ---------- */

async function viewSettings() {
  state.config = await cachedGet("/config");
  const c = state.config;

  const saveField = (mutate) => (e) =>
    queueSave((next) => { mutate(next, e.target.value.trim()); return next; });

  view.replaceChildren(
    pageTitle("Settings"),
    h("div", { class: "card bg-base-200 border max-w-3xl mb-4" },
      h("div", { class: "card-body gap-3" },
        sectionLabel("Dashboard"),
        h("div", { class: "grid-2 gap-4" },
          labeled("Host", h("input", { class: "input input-sm w-full font-mono", value: c.dashboard.host,
            onchange: saveField((n, v) => (n.dashboard.host = v)) }),
            "127.0.0.1 keeps the dashboard reachable only from this machine; 0.0.0.0 exposes it to the network."),
          labeled("Port", h("input", { class: "input input-sm w-full font-mono", type: "number", value: c.dashboard.port,
            onchange: saveField((n, v) => (n.dashboard.port = Number(v))) })),
        ),
        h("p", { class: "text-xs opacity-50" }, "Applies on the next daemon restart."),
      ),
    ),
    h("div", { class: "card bg-base-200 border max-w-3xl mb-4" },
      h("div", { class: "card-body gap-3" },
        sectionLabel("Sessions"),
        h("div", { class: "grid-2 gap-4" },
          labeled("Days idle before a new thread",
            h("input", { class: "input input-sm w-full font-mono", type: "number", min: "1", value: c.session?.idleDays ?? 7,
              onchange: saveField((n, v) => (n.session = { ...n.session, idleDays: Math.max(1, Number(v) || 7) })) }),
            "A conversation quiet for this many days starts a fresh thread — with clean context — on its next message."),
          labeled("Days to keep old threads",
            h("input", { class: "input input-sm w-full font-mono", type: "number", min: "1", value: c.session?.retentionDays ?? 30,
              onchange: saveField((n, v) => (n.session = { ...n.session, retentionDays: Math.max(1, Number(v) || 30) })) }),
            "Threads idle longer than this are deleted from disk, including their history and request logs."),
        ),
      ),
    ),
    installCard(),
    h("div", { class: "card bg-base-200 border max-w-3xl" },
      h("div", { class: "card-body gap-3" },
        sectionLabel("Voice transcription"),
        labeled("Command",
          h("textarea", { class: "textarea w-full font-mono text-xs", rows: "4", placeholder: "whisper-cli --model … {{file}}",
            onchange: saveField((n, v) => (n.transcription = v ? { command: v } : undefined)) },
            c.transcription?.command ?? ""),
          "Runs locally for each incoming voice note. {{file}} is the audio path; stdout becomes the message text. Leave empty to disable."),
      ),
    ),
  );
}

/**
 * Putting eleven on the home screen. Which of the three states you get is the
 * browser's decision, not ours: already installed, installable right now (the
 * only case where a button can do anything — see beforeinstallprompt), or a
 * browser that installs from its own menu and tells us nothing, which is every
 * one on iOS.
 */
function installCard() {
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const button = h("button", {
    class: "btn btn-sm btn-primary self-start",
    onclick: async (event) => {
      const prompt = installPrompt;
      if (!prompt) return;
      installPrompt = null; // a prompt is good for exactly one showing
      event.target.disabled = true;
      await prompt.prompt().catch(() => {});
    },
  }, "Install");
  return h("div", { class: "card bg-base-200 border max-w-3xl mb-4" },
    h("div", { class: "card-body gap-3" },
      sectionLabel("App"),
      !installed && installPrompt ? button : null,
      h("p", { class: "text-xs opacity-50" },
        installed
          ? "Running as an installed app."
          : installPrompt
            ? "Puts eleven in its own window, on the home screen or in the app list."
            : "This browser installs from its own menu — Share → Add to Home Screen on iOS, or the install icon in the address bar. It needs the dashboard on https or on localhost."),
      h("p", { class: "text-xs opacity-50" },
        "Installed or not, the interface itself is cached and opens without the network. The conversations in it still need the daemon."),
    ),
  );
}

/* ---------- shared bits ---------- */

/** `actions` ride on the title's own line, which is where a control that
 *  belongs to the whole page goes instead of into a row of its own. */
function pageTitle(title, ...actions) {
  return h("div", { class: "mb-6 flex items-center gap-3 flex-wrap" },
    h("h1", { class: "page-title" }, title),
    ...actions,
  );
}

const sectionLabel = (text) => h("div", { class: "section-label" }, text);

const INFO_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="info"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7.2" x2="8" y2="11.2"/><circle cx="8" cy="4.7" r="0.9" fill="currentColor" stroke="none"/></svg>`;

/** The ⓘ — the place for the longer explanation the label doesn't need. A
 *  button rather than a span so a finger can reach it: nothing hovers on a
 *  phone, and the tip also shows on focus (.tooltip:focus in style.css). */
const info = (tip) => h("button", { type: "button", class: "tooltip tooltip-right info-icon", "data-tip": tip, "aria-label": tip, html: INFO_ICON });

function labeled(label, control, tip) {
  return h("div", {},
    h("div", { class: "text-xs dim-label mb-1 flex items-center gap-1.5" }, label, tip ? info(tip) : null),
    control,
  );
}

/* ---------- route loading indicator ---------- */

// Painting a view means fetching first, so a sidebar click can spend a few
// hundred milliseconds looking like nothing happened. The bar (styled in
// style.css) says "heard you" — after a short delay, because a route that
// resolves quickly would flash it and read as a glitch rather than as feedback.
// Loads can overlap (a config poll landing mid-navigation), so a depth counter
// owns the state: the bar clears when the last one finishes, not the first.
const LOADING_DELAY_MS = 150;
let loadingDepth = 0;
let loadingTimer;

function beginLoading(swap) {
  if (++loadingDepth > 1) return;
  loadingTimer = setTimeout(() => {
    document.body.classList.add("is-loading");
    // Only a whole-page swap fades the view out. A load that replaces one part
    // of the page (opening a thread) leaves the rest at full strength — it is
    // still the current, clickable page.
    if (swap) document.body.classList.add("is-swapping");
  }, LOADING_DELAY_MS);
  view.setAttribute("aria-busy", "true");
}

function endLoading() {
  if (--loadingDepth > 0) return;
  loadingDepth = 0;
  clearTimeout(loadingTimer);
  document.body.classList.remove("is-loading", "is-swapping");
  view.removeAttribute("aria-busy");
}

/** Runs `work` with the loading bar armed, whatever it does or throws. */
async function withLoading(work, { swap = false } = {}) {
  beginLoading(swap);
  try { return await work(); } finally { endLoading(); }
}

/* ---------- router ---------- */

const routes = { threads: viewThreads, workspaces: viewWorkspaces, models: viewModels, providers: viewModels, usage: viewUsage, settings: viewSettings, channels: viewWorkspaces };

async function render() {
  // Whatever moved the address bar — a link in the drawer, the back gesture, a
  // toast — the drawer has said its piece and the page underneath it changed.
  setNav(false);
  const name = (location.hash.replace("#/", "") || "threads").split("/")[0];
  const route = routes[name] ?? viewThreads;
  for (const link of document.querySelectorAll("aside .menu a")) {
    link.classList.toggle("menu-active",
      (link.dataset.view === name)
      || (name === "channels" && link.dataset.view === "workspaces")
      || (name === "providers" && link.dataset.view === "models"));
  }
  // Collapse sections are checkbox-driven, so a structural re-render (any
  // config save that rebuilds the view) would slam them all shut. Snapshot
  // which ones are open and reopen them after the rebuild — stale ids (a
  // removed row, another page) simply match nothing.
  const openCollapses = [...view.querySelectorAll(".collapse[data-collapse]")]
    .filter((el) => el.querySelector(":scope > input:checked"))
    .map((el) => el.dataset.collapse);
  try {
    await withLoading(async () => {
      state.overview = await cachedGet("/overview");
      applyPairingBadge();
      await route();
    }, { swap: true });
  } catch (error) {
    view.replaceChildren(loadFailure(error));
  }
  for (const id of openCollapses) {
    const input = view.querySelector(`.collapse[data-collapse="${CSS.escape(id)}"] > input`);
    if (input) input.checked = true;
  }
}

/**
 * A hash change is usually a route change — but not when it only moves between
 * the thread list and a conversation. Those are two halves of the threads view
 * that is already on screen (two *screens* on a phone), and re-rendering would
 * refetch the list and tear the pane down under whoever is reading it. This is
 * the path the back gesture takes, so it happens constantly on mobile.
 */
/**
 * The view when the first read of a page fails.
 *
 * Worth its own shape now that the shell is cached: an installed eleven opens
 * on a train with no signal and paints perfectly, and then every number on it
 * is missing. "Failed to fetch" reads as a bug in the page; the page is fine,
 * and what is actually wrong — no network, or a daemon that isn't running — is
 * two different problems with two different fixes.
 */
function loadFailure(error) {
  const offline = !navigator.onLine;
  const unreachable = offline || error instanceof TypeError; // fetch rejects with a TypeError
  return h("div", { class: "flex flex-col gap-3 self-start" },
    h("div", { class: "alert alert-error" },
      offline ? "This device is offline. The interface is cached; the conversations in it are not."
        : unreachable ? "Can't reach the eleven daemon — check that it is running."
        : `Could not load: ${error.message}`),
    h("button", { class: "btn btn-sm self-start", onclick: () => render() }, "Try again"),
  );
}

window.addEventListener("hashchange", () => {
  const layout = threadsLayout();
  const [route, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (!layout || (route || "threads") !== "threads") return render();
  setNav(false);
  layout.classList.toggle("pane-open", Boolean(id));
  if (id && id !== state.activeThread?.id) openThread(id);
});

// The other half of the back gesture: the launcher opens the pane without
// changing the hash (it has no thread to name yet), so backing out of it fires
// popstate alone. `pane` marks the entries this page pushed for that — landing
// on anything else means the pane is not what the reader is on anymore.
window.addEventListener("popstate", () => {
  if (!history.state?.pane) threadsLayout()?.classList.remove("pane-open");
});

/* ---------- mobile nav drawer ---------- */

const setNav = (open) => {
  document.body.classList.toggle("nav-open", open);
  document.getElementById("nav-toggle")?.setAttribute("aria-expanded", String(open));
};
document.getElementById("nav-toggle")?.addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
document.getElementById("nav-backdrop")?.addEventListener("click", () => setNav(false));
// Any navigation from inside the drawer (nav links or the wordmark) closes it.
document.getElementById("sidebar")?.addEventListener("click", (e) => { if (e.target.closest("a")) setNav(false); });
// Escape closes the drawer; growing past the mobile breakpoint clears any open
// state.
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setNav(false); });
phoneQuery.addEventListener("change", (e) => { if (!e.matches) setNav(false); });

/* And the drawer follows the finger: out from the left edge, back from anywhere
   on it. The hamburger sits in the top-left corner, which is the one spot a
   thumb on a phone can't reach without regripping — and the drawer is the whole
   navigation, so that's a stretch several times a session. */
const drag = navDrag();
/** Something the finger could be scrolling sideways instead — a code block, a
 *  wide table. It was there first; the drawer doesn't get to take the gesture. */
function scrollsSideways(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") return true;
  }
  return false;
}
/** Hand the position to CSS. While this class is on, the drawer sits wherever
 *  the finger left it and nothing animates — the transition is for taps. */
const paintDrag = (progress) => {
  document.body.classList.add("nav-dragging");
  document.body.style.setProperty("--nav-progress", String(progress));
};
const dropDrag = () => {
  document.body.classList.remove("nav-dragging");
  document.body.style.removeProperty("--nav-progress");
};
document.addEventListener("touchstart", (e) => {
  if (!isPhone() || e.touches.length > 1) { drag.cancel(); dropDrag(); return; }
  const open = document.body.classList.contains("nav-open");
  // While it's open, only the drawer and its backdrop can be swiped away: the
  // page is behind both of them, not under the finger.
  if (open && !e.target.closest?.("#sidebar, .nav-backdrop")) return;
  const started = drag.start({
    x: e.touches[0].clientX,
    y: e.touches[0].clientY,
    at: e.timeStamp,
    open,
    drawer: document.getElementById("sidebar")?.offsetWidth ?? 0,
    screen: window.innerWidth,
  });
  if (started && !open && scrollsSideways(e.target)) drag.cancel();
}, { passive: true });
// Non-passive: a drawer that follows the finger has to stop the page scrolling
// under it, and preventDefault from a passive listener is ignored.
document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) { drag.cancel(); dropDrag(); return; }
  const at = drag.move({ x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp });
  if (!at) return;
  if (e.cancelable) e.preventDefault();
  paintDrag(at.progress);
}, { passive: false });
document.addEventListener("touchend", () => {
  const settled = drag.end();
  // Drop the class first: that puts the transition back, so the position the
  // finger left behind is what setNav's final state animates from.
  dropDrag();
  if (settled) setNav(settled.open);
});
document.addEventListener("touchcancel", () => { drag.cancel(); dropDrag(); });

/* ---------- the phone's viewport ---------- */

// dvh knows about the browser's own bars but not about the on-screen keyboard:
// iOS slides that over the page instead of resizing the page, so the composer
// ends up behind the keys while the transcript still claims the whole screen.
// The visual viewport is the part actually visible, and the difference between
// it and the window is what the keyboard is covering — style.css subtracts
// --keyboard from the threads screen's height. Where the browser does resize
// the layout instead (most Android ones), the difference is zero and this
// costs nothing.
const viewport = window.visualViewport;
if (viewport) {
  let covered = 0;
  const measure = () => {
    // offsetTop counts the page the browser scrolled up to reveal the focused
    // field: those pixels are hidden by the keyboard just the same.
    const next = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    if (Math.abs(next - covered) < 2) return; // sub-pixel jitter while a bar animates
    const opening = next > covered;
    covered = next;
    document.documentElement.style.setProperty("--keyboard", `${next}px`);
    // Typing shouldn't bury the message you are answering.
    if (opening) requestAnimationFrame(() => scrollToBottom());
  };
  viewport.addEventListener("resize", measure);
  viewport.addEventListener("scroll", measure);
  measure();
}

/* ---------- installable app ---------- */

// The worker is what makes eleven installable, and what answers a cold start
// with no network with something other than an error page. Registered after
// load so it never competes with the first paint; failures are silent, because
// a dashboard reached over plain http on a LAN address cannot have one and
// works perfectly well without it.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Chromium hands the install over exactly once, through this event, and only
// when it decides the page qualifies. Holding on to it is the only way to put
// the offer somewhere the user might look for it (Settings) rather than
// wherever the browser felt like putting its own.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  // Settings may already be on screen saying this browser installs from its own
  // menu — which just stopped being true.
  if (location.hash.startsWith("#/settings")) render();
});
window.addEventListener("appinstalled", () => { installPrompt = null; });

initStringLights();
connectWs();
render(); // fetches /overview once and paints the pairing badge from it


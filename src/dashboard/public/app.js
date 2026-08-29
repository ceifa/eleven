/* eleven dashboard — vanilla SPA, hand-written CSS, no build step. */

import { syncChildren } from "./dom.js";
import { md } from "./markdown.js";

const view = document.getElementById("view");
const state = {
  threads: [],
  activeThread: null,
  /** Durable transcript rows as the session file has them, oldest first. */
  timeline: [],
  requests: [],
  /** The running turn's activity in order: prose, tool calls, provider requests. */
  live: [],
  /** Messages that exist but haven't landed in the transcript yet — just sent
   *  from here, or just arrived from a channel. */
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
};
state.showRequests = prefs.get("requests", "0") === "1";

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

const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);
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
        renderLive(true);
      }
    }
    if (message.type === "delta") {
      markThreadLive(message.threadId);
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
    if (message.type === "turn-done" || message.type === "turn-error") {
      markThreadIdle(message.threadId);
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
    if (message.type === "activity") {
      // Show the message now instead of at the end of the turn: a Telegram
      // message (or a reply eleven sent on its own) is real the moment the
      // daemon reports it, and the next transcript read reconciles it.
      if (active && message.text) {
        const role = message.direction === "in" ? "user" : "assistant";
        // A reply from the running turn is already on screen as streamed prose;
        // only one eleven sent outside a turn (the operator "send") needs a bubble.
        if (role === "user" || !state.live.some((item) => item.kind === "text")) showPending(role, message.text);
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
      onclick: () => { openThread(thread.id); openPaneMobile(); },
    },
    h("div", { class: "card-body py-3 px-4" },
      // What you recognize a thread by: the forum topic, the group, or the
      // person in the DM — not the first 80 characters they happened to type.
      h("div", { class: "flex items-center gap-2 text-sm" },
        channelSource(thread.sessionKey),
        h("span", { class: "truncate min-w-0" }, thread.conversationName ?? thread.sessionKey),
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
    state.pending = [];
  }
  const data = await withLoading(() => api.get(`/threads/${id}`).catch(() => null));
  if (!data || seq !== openSeq) return;
  state.activeThread = data.thread;
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
    if (!data.live) state.live = [];
    else if (!state.live.length) state.live = data.live.items ?? [];
  }
  renderThreadPane();
  renderThreadList();
}

// A pending bubble is redundant once the same message shows up in the
// transcript. Compare a prefix: the activity broadcast clips long messages.
const MATCH_CHARS = 200;
const landed = (pending) =>
  state.timeline.some(
    (item) => item.kind === "message" && item.role === pending.role && item.text.slice(0, MATCH_CHARS) === pending.text.slice(0, MATCH_CHARS),
  );

/** Show a message that isn't in the transcript yet (and won't be until the turn
 *  persists it), unless it's already on screen. */
function showPending(role, text) {
  const message = { role, text };
  if (landed(message) || state.pending.some((p) => p.role === role && p.text.slice(0, MATCH_CHARS) === text.slice(0, MATCH_CHARS))) return;
  state.pending.push(message);
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
const openPaneMobile = () => document.getElementById("threads-layout")?.classList.add("pane-open");
const closePaneMobile = () => document.getElementById("threads-layout")?.classList.remove("pane-open");
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

/**
 * One message. `grouped` means the previous row was the same speaker moments
 * ago, so the bubble tucks under it instead of opening a new block; the
 * timestamp is rendered on every message and CSS hides the ones a grouped
 * follower makes redundant, which keeps the time visible exactly once per run
 * of messages without the builder having to look ahead.
 */
function messageBubble(message, { streaming = false, grouped = false, at } = {}) {
  const isUser = message.role === "user";
  return h("div", { class: `chat ${isUser ? "chat-end" : "chat-start"}${grouped ? " is-grouped" : ""}` },
    h("div", { class: `chat-bubble${streaming ? " msg-streaming" : ""}` },
      h("div", { class: "msg-body", html: md(message.text) }),
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

/** Messages closer together than this, from the same speaker, read as one block. */
const GROUP_WINDOW_MS = 4 * 60_000;

/** The durable rows in the order they happened. Tool calls and requests already
 *  rendered in the live region are skipped: they're the running turn's, and the
 *  live record knows how they interleave with prose the transcript can't see. */
function durableRows() {
  const liveIds = new Set(state.live.filter((item) => item.kind !== "text").map((item) => item.id));
  const rows = [];
  let at = 0;
  for (const item of state.timeline) {
    // Undated rows (older sessions) inherit the last known time so they can't
    // sort to the top of the transcript.
    at = Date.parse(item.timestamp) || at;
    if (item.kind === "message") rows.push({ at, tie: 0, message: item });
    else if (item.kind === "error") rows.push({ at, tie: 0, node: () => turnErrorRow(item.text) });
    else {
      const calls = item.calls.filter((call) => !liveIds.has(call.id));
      if (calls.length) rows.push({ at, tie: 0, node: () => toolCallsBlock(calls) });
    }
  }
  // The exact moments eleven called an AI provider, interleaved by time — a
  // request precedes the message it produced, hence the tiebreak.
  if (state.showRequests) {
    for (const request of state.requests) {
      if (!liveIds.has(request.id)) rows.push({ at: request.at, tie: 1, node: () => requestChip(request) });
    }
  }
  rows.sort((a, b) => a.at - b.at || a.tie - b.tie);

  const nodes = [];
  let day;
  let lastRole;
  let lastAt = 0;
  for (const row of rows) {
    // A transcript spanning days reads as one endless column without these —
    // and "when did I ask that?" is the question a reader scrolls back with.
    const rowDay = row.at ? startOfDay(row.at) : undefined;
    if (rowDay && rowDay !== day) {
      day = rowDay;
      lastRole = undefined;
      nodes.push(daySeparator(row.at));
    }
    if (!row.message) {
      lastRole = undefined; // anything between two messages breaks the run
      nodes.push(row.node());
      continue;
    }
    const grouped = row.message.role === lastRole && row.at - lastAt < GROUP_WINDOW_MS;
    nodes.push(messageBubble(row.message, { grouped, at: row.at }));
    lastRole = row.message.role;
    lastAt = row.at;
  }
  return nodes;
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
    if (last?.kind === "text") region.lastElementChild.querySelector(".msg-body").innerHTML = md(last.text);
  });
}

function liveNode(item) {
  if (item.kind === "tool") return toolCallsBlock([item]);
  if (item.kind === "request") {
    return state.showRequests ? requestChip({ id: item.id, model: item.model, at: item.at, bytes: 0 }) : h("div", { hidden: true });
  }
  return messageBubble({ role: "assistant", text: item.text }, { streaming: true });
}

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
      ),
    ),
    h("div", { class: "thread-head-actions" },
      // Says the same thing the sign in the sidebar does, at the one place a
      // reader of this thread is already looking.
      h("span", { class: "running-pill" }, h("i", { class: "running-dot" }), "running"),
      h("button", {
        class: `toolbar-icon${state.showRequests ? " is-active" : ""}`,
        title: state.showRequests ? "hide provider requests" : "show provider requests",
        "aria-label": "Provider requests",
        "aria-pressed": String(state.showRequests),
        onclick: toggleRequests,
      }, "⚡"),
      threadMenu(thread.id),
    ),
  );
}

function toggleRequests() {
  state.showRequests = !state.showRequests;
  prefs.set("requests", state.showRequests ? "1" : "0");
  renderThreadPane();
}

/** The ⋯ overflow. Native <details> so Escape and click-outside are the only
 *  things left to wire up, and so it needs no focus bookkeeping of its own. */
function threadMenu(id) {
  const menu = h("details", { class: "thread-menu" },
    h("summary", { class: "toolbar-icon", title: "more", "aria-label": "More actions" }, "⋯"),
    h("div", { class: "thread-menu-body" },
      h("button", { class: "menu-item", onclick: () => { menu.open = false; copyText(id, "Thread id copied."); } }, "Copy thread id"),
      deleteThreadButton(id),
    ),
  );
  return menu;
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
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  };
  textarea.addEventListener("input", fit);
  // The first fit has to wait for the element to be in the document — before
  // that scrollHeight is 0 and the box would collapse.
  requestAnimationFrame(fit);
  return textarea;
}

function threadComposer(thread) {
  const text = autoGrow(h("textarea", {
    class: "composer-text",
    id: "composer-text",
    placeholder: `Message ${thread.workspace}…`,
    rows: "1",
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } },
  }));
  return h("form", { class: "composer", onsubmit: sendMessage },
    h("div", { class: "composer-box" },
      text,
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
    h("div", { class: "composer-hint" }, "Enter to send · Shift+Enter for a new line"),
  );
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
  const opened = renderedThreadId !== thread.id || !pane.querySelector("#composer-text");
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
          // Shown by CSS only while a turn runs and has produced nothing yet —
          // the gap between "sent" and the first token used to look like a hang.
          h("div", { class: "typing" }, h("i"), h("i"), h("i")),
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

  // Both regions live inside the pane, so they can only be filled once it's
  // attached; the scroll position is applied after, over the finished height.
  renderPending();
  renderLive(true);
  const messages = scroller();
  if (messages) messages.scrollTop = keepScroll ?? messages.scrollHeight;
  updateJumpButton();
  // Opening a thread is almost always the first half of answering in it, so the
  // caret lands in the composer. Not on a phone, where it would slide the
  // keyboard over the conversation you just tapped into.
  if (opened && !isPhone()) document.getElementById("composer-text")?.focus();
}

// Mirrors the `max-width: 768px` breakpoint in style.css — no build step here
// to share a constant, so the two have to be kept in sync by hand.
const phoneQuery = matchMedia("(max-width: 768px)");
const isPhone = () => phoneQuery.matches;

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
  const input = document.getElementById("composer-text");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.dispatchEvent(new Event("input")); // shrink the grown box back to one row
  // Optimistic bubble: it stays until the transcript read finds the real one,
  // so a long turn doesn't leave the message you just sent off-screen.
  const message = { role: "user", text };
  state.pending.push(message);
  renderPending();
  scrollToBottom(); // your own message is always worth following down to
  try {
    await api.send("POST", `/threads/${state.activeThread.id}/message`, { text });
  } catch (error) {
    // The send failed — drop the optimistic bubble and restore the draft so it
    // doesn't look delivered.
    toast(error.message, true);
    state.pending = state.pending.filter((entry) => entry !== message);
    input.value = text;
    input.dispatchEvent(new Event("input"));
    renderPending();
  }
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
        h("div", { class: "flex flex-col gap-2 overflow-y-auto pr-2 pt-1", id: "thread-list" }),
      ),
      h("div", { class: "flex-1 min-w-0 flex flex-col bg-base-100 border rounded-box", id: "thread-pane" }),
    ),
  );
  renderThreadList();
  renderThreadPane();
  if (state.activeThread) openThread(state.activeThread.id);
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
function newThreadDialog() {
  const pane = document.getElementById("thread-pane");
  if (!pane) return;
  const workspaces = state.overview?.workspaces ?? [];
  const previous = state.activeThread;
  state.activeThread = null;
  renderedThreadId = undefined;
  pane.classList.remove("is-running");
  pane.classList.add("is-composing");

  const remembered = prefs.get("workspace", "");
  let workspace = workspaces.includes(remembered) ? remembered : workspaces[0];

  const text = autoGrow(h("textarea", {
    class: "composer-text new-thread-text",
    placeholder: "What do you need?",
    rows: "3",
    oninput: () => refreshStart(),
    onkeydown: (event) => {
      if (event.key === "Escape") return cancel();
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); start(); }
    },
  }));

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
  // No workspace configured yet means there is nowhere to run a turn — the
  // button says so by staying off rather than by swallowing the click.
  const refreshStart = () => { startButton.disabled = !text.value.trim() || !workspace || starting; };

  let starting = false;
  async function start() {
    if (starting || !text.value.trim() || !workspace) return;
    starting = true;
    startButton.textContent = "Starting…";
    refreshStart();
    const thread = await api
      .send("POST", "/threads", { workspace, text: text.value.trim() })
      .catch((error) => (toast(error.message, true), null));
    if (!thread) {
      // Leave the draft exactly where it was — it is the only copy.
      starting = false;
      startButton.textContent = "Start";
      refreshStart();
      return;
    }
    prefs.set("workspace", workspace);
    await refreshThreads();
    openThread(thread.id);
  }

  function cancel() {
    // Back to whatever was open before the launcher took the pane.
    state.activeThread = previous;
    renderThreadPane();
    renderThreadList();
    if (!previous) closePaneMobile();
  }

  pane.replaceChildren(
    h("div", { class: "new-thread" },
      h("div", { class: "new-thread-card" },
        h("div", { class: "new-thread-head" },
          backButton(),
          h("h2", { class: "page-title" }, "New thread"),
        ),
        h("div", { class: "composer-box is-tall" }, text),
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
          h("span", { class: "composer-hint" }, "Enter to start · Shift+Enter for a new line"),
          h("button", { class: "btn btn-ghost", type: "button", onclick: cancel }, "Cancel"),
          startButton,
        ),
      ),
    ),
  );
  renderThreadList(); // the list must stop showing a thread as open
  text.focus();
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
      ...requests.map((request) =>
        h("div", { class: "flex items-center gap-3 py-1" },
          h("span", { class: "text-lg" }, request.kind === "group" ? "👥" : "👤"),
          h("div", { class: "flex-1 min-w-0" },
            h("div", { class: "truncate" },
              request.kind === "group"
                ? `group "${request.chatTitle ?? request.chatId}"`
                : `${request.name ?? "?"} ${request.username ? `(@${request.username})` : ""}`,
            ),
            h("div", { class: "text-xs opacity-60 font-mono" }, `→ ${request.bot} · ${request.kind === "group" ? `chat ${request.chatId}` : `user ${request.userId}`} · ${timeAgo(request.createdAt)} ago`),
          ),
          h("button", { class: "btn btn-success btn-sm", onclick: () => pairingAction(request.id, "approve") }, "Approve"),
          h("button", { class: "btn btn-ghost btn-sm", onclick: () => pairingAction(request.id, "deny") }, "Deny"),
        ),
      ),
    ),
  );
}

function workspaceCard(name, workspace) {
  return h("div", { class: "card bg-base-200 border mb-6" },
    h("div", { class: "card-body gap-5" },
      h("div", { class: "flex items-center gap-3 wrap-mobile" },
        h("h2", { class: "display text-xl" }, name),
        h("span", { class: "text-xs opacity-50 font-mono truncate min-w-0" }, workspace.path),
        h("button", { class: "btn btn-ghost btn-xs ml-auto text-error", onclick: () =>
          queueSave((next) => { delete next.workspaces[name]; return next; }, { structural: true }) }, "remove workspace"),
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
      h("div", { class: "flex items-center gap-2 wrap-mobile" },
        h("span", { html: CHANNEL_ICONS[channel.type] ?? "" }),
        h("span", { class: "font-mono font-semibold" }, channel.name),
        status?.username
          ? h("a", { class: "text-xs link link-hover opacity-60", href: `https://t.me/${status.username}`, target: "_blank", rel: "noopener" }, `@${status.username}`)
          : null,
        h("span", { class: `badge badge-sm ${status?.connected ? "badge-success" : "badge-error"} badge-soft ml-2` }, status?.connected ? "polling" : "offline"),
        h("button", { class: "btn btn-ghost btn-xs ml-auto text-error", onclick: () =>
          updateWorkspace(workspaceName, (ws) => { ws.channels = (ws.channels ?? []).filter((_, i) => i !== index); }, { structural: true }) }, "remove"),
      ),
      h("div", { class: "grid-3 gap-4" },
        labeled("Bot token", h("input", { type: "password", class: "input input-sm w-full font-mono", value: channel.token,
          onchange: (e) => save({ token: e.target.value }) })),
        h("div", {}), h("div", {}), // grid fillers — users and groups get full-width blocks below
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
  const editor = custom
    ? h("textarea", { class: "textarea w-full font-mono text-xs", rows: "8", placeholder: "your custom personality/style block…",
        onchange: (e) => setPrompt(e.target.value, false) }, workspace.systemPrompt ?? "")
    : h("textarea", { class: "textarea w-full font-mono text-xs opacity-60", rows: "8", readonly: true },
        state.overview?.builtinSystemPrompt ?? "");
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
        h("div", { class: "flex items-center gap-2" },
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
      h("span", { class: "text-xs opacity-50 ml-auto mr-2" }, group.requireMention === false ? "replies freely" : "@mention required"),
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
  return h("div", { class: "flex gap-2 items-center stack-mobile" },
    type, name, token,
    h("button", { class: "btn btn-sm", onclick: () => {
      if (!name.value.trim() || !token.value.trim()) return;
      return updateWorkspace(workspaceName, (ws) => {
        ws.channels = [...(ws.channels ?? []), { type: type.value, name: name.value.trim(), token: token.value.trim(), users: {} }];
      }, { structural: true });
    } }, "Add"),
  );
}

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
      slot.append(h("div", { class: "text-xs opacity-40" }, "this provider doesn't report subscription usage"));
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

/* ---------- shared bits ---------- */

function pageTitle(title) {
  return h("div", { class: "mb-6" }, h("h1", { class: "page-title" }, title));
}

const sectionLabel = (text) => h("div", { class: "section-label" }, text);

const INFO_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="info"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7.2" x2="8" y2="11.2"/><circle cx="8" cy="4.7" r="0.9" fill="currentColor" stroke="none"/></svg>`;

/** Hoverable ⓘ — the place for the longer explanation the label doesn't need. */
const info = (tip) => h("span", { class: "tooltip tooltip-right info-icon", "data-tip": tip, html: INFO_ICON });

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

const routes = { threads: viewThreads, workspaces: viewWorkspaces, models: viewModels, providers: viewModels, settings: viewSettings, channels: viewWorkspaces };

async function render() {
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
    view.replaceChildren(h("div", { class: "alert alert-error" }, `Could not load: ${error.message}`));
  }
  for (const id of openCollapses) {
    const input = view.querySelector(`.collapse[data-collapse="${CSS.escape(id)}"] > input`);
    if (input) input.checked = true;
  }
}

window.addEventListener("hashchange", render);

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

initStringLights();
connectWs();
render(); // fetches /overview once and paints the pairing badge from it


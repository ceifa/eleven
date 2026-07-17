/* eleven dashboard — vanilla SPA, hand-written CSS, no build step. */

const view = document.getElementById("view");
const state = {
  threads: [],
  activeThread: null,
  messages: [],
  requests: [],
  streaming: "",
  workspaceFilter: "",
  overview: null,
  config: null,
};

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
const CHANNEL_ICONS = { telegram: TELEGRAM_ICON };

// A thread's origin — the sessionKey's prefix is the channel type
// (telegram:…, dashboard:…). Show the channel glyph when we have one, else the
// bare type; the title keeps the source readable either way.
function channelSource(sessionKey) {
  const type = sessionKey.split(":")[0];
  const icon = CHANNEL_ICONS[type];
  return icon ? h("span", { class: "channel-glyph", title: type, html: icon }) : h("span", {}, type);
}

// Escapes text for both element and attribute contexts. The quote escape
// matters for links: md() drops the captured URL into an href="…", and without
// it a message like [x](https://a" onerror=…) could break out of the attribute.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Minimal markdown for transcripts: fences, inline code, bold, italics, links, headings. */
function md(text) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  let out = "";
  for (let i = 0; i < parts.length; i += 3) {
    out += inline(parts[i]);
    if (parts[i + 2] !== undefined) out += `<pre><code>${esc(parts[i + 2])}</code></pre>`;
  }
  return out;
}
function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/^#{1,4} (.+)$/gm, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="link" href="$2" target="_blank" rel="noopener">$1</a>');
}

const timeAgo = (ts) => {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

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
    pulse();
    stripFlash();
    if (message.type === "delta") {
      markThreadLive(message.threadId);
      if (message.threadId === state.activeThread?.id) {
        state.streaming += message.delta;
        renderStreaming();
      }
    }
    if (message.type === "provider-request") {
      markThreadLive(message.threadId);
      if (message.threadId === state.activeThread?.id) {
        // Live chip while the turn runs; the turn-done refresh replaces it with the durable one.
        const container = document.getElementById("messages");
        if (container) {
          const stick = atBottom(container);
          const chip = requestChip({ id: message.id, model: message.model, at: Date.now(), bytes: 0 });
          const streaming = container.querySelector("[data-streaming]");
          streaming ? container.insertBefore(chip, streaming) : container.append(chip);
          if (stick) container.scrollTop = container.scrollHeight;
        }
      }
    }
    if (message.type === "tool-call") {
      markThreadLive(message.threadId);
      if (message.threadId === state.activeThread?.id) {
        // Live tool indicator while the turn runs (deltas only stream prose);
        // the turn-done refresh replaces it with the durable on-disk rendering.
        const container = document.getElementById("messages");
        if (container) {
          const stick = atBottom(container);
          const chip = h("div", { class: "mt-1 text-xs opacity-60 font-mono" }, `⚙ ${message.name} ${message.summary ?? ""}`.trim());
          const streaming = container.querySelector("[data-streaming]");
          streaming ? container.insertBefore(chip, streaming) : container.append(chip);
          if (stick) container.scrollTop = container.scrollHeight;
        }
      }
    }
    if (message.type === "turn-done" || message.type === "turn-error") {
      markThreadIdle(message.threadId);
      if (message.type === "turn-error") {
        toast(message.error, true);
        stripError();
      }
      if (message.threadId === state.activeThread?.id) openThread(message.threadId);
      refreshThreads();
    }
    if (message.type === "thread-deleted") {
      markThreadIdle(message.threadId);
      if (message.threadId === state.activeThread?.id) {
        state.activeThread = null;
        renderThreadPane();
        closePaneMobile();
      }
      refreshThreads();
    }
    if (message.type === "activity") scheduleThreadRefresh(message.workspace);
    if (message.type === "config-changed") onConfigChanged();
    if (message.type === "pairing") {
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

// Which threads have a turn running right now, reflected as the breathing amber
// halo on their list cards. delta/provider-request light a thread;
// turn-done/turn-error clear it. A per-thread safety timer clears a thread whose
// end event we miss (e.g. a dropped socket) — each new event refreshes it.
// A thread is live iff it has a safety timer — the Map is the single source of
// truth (renderThreadList reads it too).
const threadLiveTimers = new Map();
function markThreadLive(threadId) {
  if (!threadId) return;
  const wasLive = threadLiveTimers.has(threadId);
  clearTimeout(threadLiveTimers.get(threadId));
  threadLiveTimers.set(threadId, setTimeout(() => markThreadIdle(threadId), 12_000));
  if (!wasLive) applyThreadLive(threadId); // already-lit card: skip the DOM query per delta
}
function markThreadIdle(threadId) {
  if (!threadId || !threadLiveTimers.has(threadId)) return;
  clearTimeout(threadLiveTimers.get(threadId));
  threadLiveTimers.delete(threadId);
  applyThreadLive(threadId);
}
// Toggle the class on the card directly so a burst of deltas doesn't re-render
// the whole list; renderThreadList re-applies from the map on any full rebuild.
function applyThreadLive(threadId) {
  const card = document.querySelector(`#thread-list [data-thread-id="${threadId}"]`);
  if (card) card.classList.toggle("is-live", threadLiveTimers.has(threadId));
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
  const overview = await api.get("/overview").catch(() => null);
  if (overview) state.overview = overview;
  applyPairingBadge();
}

/* ---------- threads view ---------- */

const onThreadsView = () => location.hash.startsWith("#/threads") || location.hash === "" || location.hash === "#/";

async function refreshThreads() {
  state.threads = await api.get(`/threads${state.workspaceFilter ? `?workspace=${encodeURIComponent(state.workspaceFilter)}` : ""}`);
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
  if (!location.hash.startsWith("#/workspaces") && !location.hash.startsWith("#/settings")) return;
  const fresh = await api.get("/config").catch(() => null);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.config)) render();
}

function renderThreadList() {
  const list = document.getElementById("thread-list");
  if (!list) return;
  list.replaceChildren(
    ...state.threads.map((thread) =>
      h(
        "button",
        {
          "data-thread-id": thread.id,
          class: `card card-sm w-full bg-base-200 ${thread.id === state.activeThread?.id ? "is-active" : ""} ${threadLiveTimers.has(thread.id) ? "is-live" : ""}`,
          onclick: () => { openThread(thread.id); openPaneMobile(); },
        },
        h("div", { class: "card-body py-3 px-4" },
          h("div", { class: "truncate text-sm" }, thread.title ?? "(untitled)"),
          h("div", { class: "flex items-center gap-2 text-xs thread-meta font-mono" },
            h("span", { class: "text-warning" }, thread.workspace),
            channelSource(thread.sessionKey),
            h("span", { class: "ml-auto" }, timeAgo(thread.lastActivityAt)),
          ),
        ),
      ),
    ),
  );
}

async function openThread(id) {
  const data = await api.get(`/threads/${id}`).catch(() => null);
  if (!data) return;
  state.activeThread = data.thread;
  state.messages = data.messages;
  state.requests = data.requests ?? [];
  state.streaming = "";
  renderThreadPane();
  renderThreadList();
}

// On mobile the list and the conversation share one screen; these swap between
// them (a no-op on desktop, where both panes are always visible side by side).
const openPaneMobile = () => document.getElementById("threads-layout")?.classList.add("pane-open");
const closePaneMobile = () => document.getElementById("threads-layout")?.classList.remove("pane-open");
// Mobile-only ‹ that returns from the conversation/compose pane to the list.
const backButton = () =>
  h("button", { class: "btn btn-ghost btn-sm mobile-only px-2", "aria-label": "Back to threads", onclick: closePaneMobile },
    h("span", { html: "‹", style: "font-size:1.3rem;line-height:1" }));

function messageBubble(message, streaming = false) {
  const isUser = message.role === "user";
  return h("div", { class: `chat ${isUser ? "chat-end" : "chat-start"}` },
    h("div", { class: `chat-bubble ${isUser ? "chat-bubble-primary" : "bg-base-200 text-base-content"} ${streaming ? "msg-streaming" : ""}` },
      h("div", { class: "msg-body", html: md(message.text) }),
      message.toolCalls
        ? h("div", { class: "mt-1 text-xs opacity-60 font-mono" }, message.toolCalls.map((t) => `⚙ ${t.name} ${t.summary}`).join("\n"))
        : null,
    ),
  );
}

let renderedThreadId;
function renderThreadPane() {
  const pane = document.getElementById("thread-pane");
  if (!pane) return;
  const thread = state.activeThread;
  if (!thread) {
    renderedThreadId = undefined;
    pane.replaceChildren(
      h("div", { class: "flex items-center justify-center h-full opacity-60" },
        h("div", {}, "Pick a thread — or start one."),
      ),
    );
    return;
  }
  // Re-rendering the same thread (a turn finished) should leave a reader who
  // scrolled up where they were; switching threads or sitting at the bottom
  // jumps to the latest message.
  const prev = document.getElementById("messages");
  const keepScroll = renderedThreadId === thread.id && prev && !atBottom(prev) ? prev.scrollTop : null;
  renderedThreadId = thread.id;
  // Chronological timeline: chat messages interleaved with the exact moments
  // eleven called an AI provider (each chip opens the raw request payload).
  const timeline = [
    ...state.messages.map((m) => ({ at: Date.parse(m.timestamp) || 0, node: () => messageBubble(m) })),
    ...state.requests.map((r) => ({ at: r.at, node: () => requestChip(r) })),
  ].sort((a, b) => a.at - b.at);
  const messages = h("div", { class: "flex-1 overflow-y-auto p-4", id: "messages" },
    timeline.map((item) => item.node()));
  const composer = h("form", { class: "flex gap-2 p-3 border-t border-base-300", onsubmit: sendMessage },
    h("textarea", {
      class: "textarea flex-1 min-h-10 max-h-40",
      id: "composer-text",
      placeholder: `Message ${thread.workspace}…`,
      rows: "1",
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } },
    }),
    h("button", { class: "btn btn-primary", type: "submit" }, "Send"),
  );
  pane.replaceChildren(
    h("div", { class: "flex items-center gap-3 px-4 py-3 border-b border-base-300" },
      backButton(),
      h("strong", { class: "truncate min-w-0" }, thread.title ?? "(untitled)"),
      h("span", { class: "text-xs opacity-50 font-mono truncate min-w-0" }, thread.sessionKey),
      thread.model ? h("span", { class: "badge badge-ghost badge-sm font-mono" }, thread.model) : null,
      deleteThreadButton(thread.id),
    ),
    messages,
    composer,
  );
  messages.scrollTop = keepScroll ?? messages.scrollHeight;
}

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function requestChip(request) {
  return h("button", {
    class: "request-chip font-mono text-xs",
    title: "open the exact payload sent to the provider",
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

async function openRequestModal(request) {
  if (!state.activeThread) return; // chip clicked after the thread was cleared
  const entry = await api.get(`/requests/${state.activeThread.id}/${request.id}`).catch((e) => (toast(e.message, true), null));
  if (!entry) return;
  const json = JSON.stringify(entry.payload, null, 2);
  document.getElementById("request-modal")?.remove();

  const tree = jsonTree(entry.payload);
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

  const dialog = h("dialog", { class: "modal", id: "request-modal" },
    h("div", { class: "modal-box" },
      h("div", { class: "flex items-center gap-3 mb-3 wrap-mobile" },
        h("span", { class: "section-label" }, "Provider request"),
        h("span", { class: "font-mono text-xs opacity-60" }, `${entry.model} · ${fmtTime(entry.at)} · ${fmtBytes(json.length)}`),
        h("div", { class: "flex items-center gap-1 ml-auto" },
          h("button", { class: "btn btn-xs btn-ghost", title: "expand every node", onclick: () => tree.expandAll() }, "expand"),
          h("button", { class: "btn btn-xs btn-ghost", title: "collapse to the top level", onclick: () => tree.collapseAll() }, "collapse"),
          rawBtn,
          h("button", { class: "btn btn-xs", onclick: () => navigator.clipboard.writeText(json).then(() => toast("Copied.")) }, "copy"),
        ),
        h("form", { method: "dialog" }, h("button", { class: "btn btn-xs btn-ghost" }, "✕")),
      ),
      panel,
    ),
    h("form", { method: "dialog", class: "modal-backdrop" }, h("button", {}, "close")),
  );
  document.body.append(dialog);
  dialog.showModal();
}

// Re-rendering the whole in-progress reply per delta is quadratic in reply
// length — coalesce to one render per animation frame.
let streamRaf;
function renderStreaming() {
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(() => {
    streamRaf = undefined;
    renderStreamingNow();
  });
}

function renderStreamingNow() {
  if (!state.streaming) return; // turn ended (or thread switched) before the frame fired
  const container = document.getElementById("messages");
  if (!container) return;
  let live = container.querySelector("[data-streaming]");
  if (!live) {
    live = messageBubble({ role: "assistant", text: "" }, true);
    live.dataset.streaming = "1";
    container.append(live);
  }
  const stick = atBottom(container);
  live.querySelector(".msg-body").innerHTML = md(state.streaming);
  if (stick) container.scrollTop = container.scrollHeight; // don't yank a reader who scrolled up
}

// Deletion is irreversible (history, request logs, and referenced media all
// go), so it takes two clicks: the first arms the button, the second commits.
// No native confirm() — a modal dialog would block scripted browsers.
function deleteThreadButton(id) {
  let armed;
  const button = h("button", {
    class: "btn btn-ghost btn-xs ml-auto text-error",
    title: "delete this thread and all its files (history, requests, media)",
    onclick: () => {
      if (!armed) {
        button.textContent = "sure?";
        button.classList.add("btn-error", "btn-active");
        armed = setTimeout(() => {
          armed = undefined;
          button.textContent = "delete";
          button.classList.remove("btn-error", "btn-active");
        }, 4000);
        return;
      }
      clearTimeout(armed);
      deleteThread(id);
    },
  }, "delete");
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
  state.messages.push({ role: "user", text, timestamp: new Date().toISOString() });
  state.streaming = "";
  renderThreadPane();
  try {
    await api.send("POST", `/threads/${state.activeThread.id}/message`, { text });
  } catch (error) {
    // The send failed — roll back the optimistic bubble and restore the draft
    // so it doesn't look delivered.
    toast(error.message, true);
    state.messages.pop();
    input.value = text;
    renderThreadPane();
  }
}

async function viewThreads() {
  await refreshThreads();
  const workspaces = Object.keys(state.overview?.workspaces ?? {});
  view.replaceChildren(
    pageTitle("Threads"),
    h("div", { class: "threads-layout flex gap-4", id: "threads-layout" },
      h("div", { class: "threads-list-col w-72 shrink-0 flex flex-col gap-2" },
        h("div", { class: "flex gap-2" },
          h("select", { class: "select select-sm flex-1", onchange: (e) => { state.workspaceFilter = e.target.value; refreshThreads(); } },
            h("option", { value: "" }, "all workspaces"),
            workspaces.map((w) => h("option", { value: w, selected: state.workspaceFilter === w }, w)),
          ),
          h("button", { class: "btn btn-sm btn-primary", onclick: () => { newThreadDialog(); openPaneMobile(); } }, "New"),
        ),
        h("div", { class: "flex flex-col gap-2 overflow-y-auto pr-2 pt-1", id: "thread-list" }),
      ),
      h("div", { class: "flex-1 min-w-0 flex flex-col bg-base-100 border rounded-box", id: "thread-pane" }),
    ),
  );
  renderThreadList();
  renderThreadPane();
  if (state.activeThread) openThread(state.activeThread.id);
}

function newThreadDialog() {
  const workspaces = Object.keys(state.overview?.workspaces ?? {});
  const pane = document.getElementById("thread-pane");
  state.activeThread = null;
  const select = h("select", { class: "select w-full" }, workspaces.map((w) => h("option", { value: w }, w)));
  const text = h("textarea", { class: "textarea w-full", placeholder: "First message…", rows: "3" });
  pane.replaceChildren(
    h("div", { class: "flex items-center justify-center h-full" },
      h("div", { class: "card bg-base-200 w-full max-w-md" },
        h("div", { class: "card-body gap-3" },
          h("div", { class: "flex items-center gap-2" },
            backButton(),
            h("h2", { class: "card-title text-base" }, "New thread"),
          ),
          labeled("Workspace", select),
          labeled("Message", text),
          h("div", { class: "card-actions justify-end" },
            h("button", { class: "btn btn-primary", onclick: async () => {
              if (!text.value.trim()) return;
              const thread = await api.send("POST", "/threads", { workspace: select.value, text: text.value.trim() }).catch((e) => (toast(e.message, true), null));
              if (thread) { await refreshThreads(); openThread(thread.id); }
            } }, "Start"),
          ),
        ),
      ),
    ),
  );
}

/* ---------- workspaces view (agent + channels together) ---------- */

const ALL_TOOLS = () => state.overview?.tools ?? ["read", "bash", "edit", "write"];

async function viewWorkspaces() {
  state.config = await api.get("/config");
  const pairing = state.overview?.pairing ?? [];

  const children = [
    pageTitle("Workspaces"),
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
          labeled("Model override", h("input", { class: "input input-sm w-full font-mono", value: workspace.model ?? "", list: "models-list",
            placeholder: "inherit default", onchange: (e) => updateWorkspace(name, (ws) => { ws.model = e.target.value.trim() || undefined; }) })),
        ),
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

/** Group/topic-level: only an append. */
function appendField(value, onchange) {
  return labeled("Append to system prompt",
    h("textarea", { class: "textarea w-full font-mono text-xs", rows: "3",
      onchange: (e) => onchange(e.target.value.trim() || undefined) }, value ?? ""),
    "Extra instructions added at the end of the system prompt, only for this scope.");
}

function userRow(workspaceName, chIndex, id, user) {
  const patchUser = (patch) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.users = { ...ch.users, [id]: { ...ch.users?.[id], ...patch } };
  });
  return h("div", { class: "collapse collapse-arrow bg-base-200 border" },
    h("input", { type: "checkbox" }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold" }, user.name ?? id),
      user.username ? h("span", { class: "text-xs opacity-50" }, `@${user.username}`) : null,
      h("span", { class: "font-mono text-xs opacity-50" }, id),
      user.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      appendField(user.appendSystemPrompt, (v) => patchUser({ appendSystemPrompt: v })),
      h("button", { class: "btn btn-ghost btn-xs self-start text-error", onclick: () =>
        updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const users = { ...ch.users }; delete users[id]; ch.users = users; }, { structural: true }) }, "remove user"),
    ),
  );
}

function groupRow(workspaceName, chIndex, id, group) {
  const patchGroup = (patch) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.groups = { ...ch.groups, [id]: { ...ch.groups?.[id], ...patch } };
  });
  // Adding/removing a topic changes the rendered rows, so those re-render;
  // editing a topic's title or prompt updates in place.
  const patchTopic = (topicId, patch, structural = false) =>
    updateWorkspace(workspaceName, (ws) => {
      const g = ws.channels[chIndex].groups[id];
      const topics = { ...g.topics };
      if (patch === null) delete topics[topicId];
      else topics[topicId] = { ...topics[topicId], ...patch };
      g.topics = Object.keys(topics).length ? topics : undefined;
    }, { structural });
  return h("div", { class: "collapse collapse-arrow bg-base-200 border" },
    h("input", { type: "checkbox" }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold" }, group.title ?? id),
      h("span", { class: "font-mono text-xs opacity-50" }, id),
      group.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
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
      appendField(group.appendSystemPrompt, (v) => patchGroup({ appendSystemPrompt: v })),
      h("div", { class: "text-xs dim-label mt-1 flex items-center gap-1.5" }, "Topics",
        info("Each forum topic gets its own thread and can append its own instructions. Topics register themselves when someone first speaks in them.")),
      ...Object.entries(group.topics ?? {}).map(([topicId, topic]) =>
        h("div", { class: "border border-base-300 rounded-box p-3 flex flex-col gap-2" },
          h("div", { class: "flex items-center gap-2" },
            h("input", { class: "input input-xs w-44", value: topic.title ?? "", placeholder: "topic name (optional)",
              onchange: (e) => patchTopic(topicId, { title: e.target.value.trim() || undefined }) }),
            h("span", { class: "font-mono text-xs opacity-50" }, `topic ${topicId}`),
            topic.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
            h("button", { class: "btn btn-ghost btn-xs text-error ml-auto", onclick: () => patchTopic(topicId, null, true) }, "remove"),
          ),
          appendField(topic.appendSystemPrompt, (v) => patchTopic(topicId, { appendSystemPrompt: v })),
        ),
      ),
      h("input", { class: "input input-xs w-44 font-mono", placeholder: "add topic by id", onchange: (e) => {
        const topicId = e.target.value.trim();
        if (/^\d+$/.test(topicId)) patchTopic(topicId, {}, true);
      } }),
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
  render(); // refetches /overview and repaints the badge — no separate fetch needed
}

/* ---------- providers view ---------- */

async function viewProviders() {
  const [config, providers, models] = await Promise.all([api.get("/config"), api.get("/providers"), api.get("/models")]);
  state.config = config;
  const p = config.providers;

  view.replaceChildren(
    pageTitle("Providers"),
    h("datalist", { id: "models-list" }, models.map((m) => h("option", { value: m }))),
    h("div", { class: "card bg-base-200 max-w-3xl mb-4" },
      h("div", { class: "card-body gap-3" },
        h("h2", { class: "card-title text-base" }, "Models"),
        labeled("Default model", h("input", { class: "input input-sm w-full font-mono", value: p.defaultModel, list: "models-list",
          onchange: (e) => queueSave((next) => { next.providers.defaultModel = e.target.value.trim(); return next; }) })),
        labeled("Fallback models",
          h("div", { class: "flex flex-wrap items-center gap-2" },
            ...p.fallbackModels.map((model, index) =>
              h("span", { class: "badge badge-ghost font-mono gap-1" }, model,
                h("button", { class: "text-error", onclick: () =>
                  queueSave((next) => { next.providers.fallbackModels.splice(index, 1); return next; }, { structural: true }) }, "✕")),
            ),
            h("input", { class: "input input-xs w-56 font-mono", list: "models-list", placeholder: "add fallback model", onchange: (e) => {
              const value = e.target.value.trim();
              if (!value) return;
              queueSave((next) => { next.providers.fallbackModels.push(value); return next; }, { structural: true });
            } }),
          ), "Tried in order when the default model fails."),
        labeled("Thinking level",
          h("select", { class: "select select-sm w-40", onchange: (e) => queueSave((next) => { next.providers.thinkingLevel = e.target.value; return next; }) },
            ["off", "minimal", "low", "medium", "high", "xhigh"].map((level) =>
              h("option", { value: level, selected: (p.thinkingLevel ?? "high") === level }, level)),
          )),
      ),
    ),
    h("div", { class: "card bg-base-200 max-w-3xl" },
      h("div", { class: "card-body gap-2" },
        h("h2", { class: "card-title text-base" }, "Provider auth"),
        h("p", { class: "text-xs opacity-60" }, "Run `pi` and /login, or set keys in ~/.pi/agent/auth.json."),
        h("table", { class: "table table-sm font-mono" },
          h("thead", {}, h("tr", {}, h("th", {}, "provider"), h("th", {}, "status"), h("th", {}, "source"))),
          h("tbody", {},
            providers.map((entry) =>
              h("tr", {},
                h("td", {}, entry.provider),
                h("td", {}, entry.configured ? h("span", { class: "text-success" }, "✓ configured") : h("span", { class: "opacity-40" }, "—")),
                h("td", { class: "opacity-60" }, entry.source ?? ""),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/* ---------- settings view ---------- */

async function viewSettings() {
  state.config = await api.get("/config");
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

/* ---------- router ---------- */

const routes = { threads: viewThreads, workspaces: viewWorkspaces, providers: viewProviders, settings: viewSettings, channels: viewWorkspaces };

async function render() {
  const name = (location.hash.replace("#/", "") || "threads").split("/")[0];
  const route = routes[name] ?? viewThreads;
  for (const link of document.querySelectorAll("aside .menu a")) {
    link.classList.toggle("menu-active", (link.dataset.view === name) || (name === "channels" && link.dataset.view === "workspaces"));
  }
  try {
    state.overview = await api.get("/overview");
    applyPairingBadge();
    await route();
  } catch (error) {
    view.replaceChildren(h("div", { class: "alert alert-error" }, `Could not load: ${error.message}`));
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
// state. The query mirrors the `max-width: 768px` breakpoint in style.css — keep
// the two in sync (no build step here to share a constant).
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setNav(false); });
matchMedia("(max-width: 768px)").addEventListener("change", (e) => { if (!e.matches) setNav(false); });

initStringLights();
connectWs();
render(); // fetches /overview once and paints the pairing badge from it

/* The WebSocket: every event the daemon broadcasts and what it does to the
   page, and the reads those events ask for (the overview, the config). It
   reaches into every view, so nothing but app.js imports it. */

import { MATCH_CHARS } from "./live-turn.js";
import { keep } from "./snapshot.js";
import { sameMessage } from "./message-display.js";
import { state } from "./state.js";
import { cachedGet, invalidate } from "./api.js";
import { toast } from "./ui.js";
import { applyPairingBadge, pulse, stripError, stripFlash } from "./chrome.js";
import { onThreadsView, render, routes } from "./router.js";
import { markThreadIdle, markThreadLive } from "./running.js";
import { pushLiveMessage, renderLive, renderPanels, scheduleLiveRender, showPending } from "./transcript.js";
import { closePaneMobile } from "./phone.js";
import { savesInFlight } from "./config.js";
import { viewWorkspaces } from "./workspaces.js";
import { forgetThread, openThread, renderThreadPane, scheduleReconcile } from "./thread-pane.js";
import { refreshThreads, scheduleThreadRefresh } from "./threads.js";

/* ---------- live updates ---------- */

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
  // The phone has no sidebar to put the dot in, so the top bar says it — and
  // only while it is true, the way a messenger says "connecting" under its name.
  const phoneStatus = document.getElementById("topbar-status");
  ws.onopen = () => {
    dot.className = "status status-success";
    label.textContent = "live";
    phoneStatus.hidden = true;
    document.body.classList.remove("ws-down");
    alive();
  };
  ws.onclose = () => {
    clearTimeout(silence);
    dot.className = "status status-error";
    label.textContent = "reconnecting";
    phoneStatus.hidden = false;
    document.body.classList.add("ws-down"); // an open conversation says it in its own head
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
    // it produced is already on disk and comes back with the transcript. What
    // the new attempt already holds comes with the event: the message that
    // opened it, on a new thread its only copy until the turn ends — unless
    // this page sent it and still shows it as a pending bubble.
    if (message.type === "turn-start" || message.type === "turn-rewound") {
      markThreadLive(message.threadId);
      if (active) {
        state.liveEpoch++;
        state.live = (message.items ?? []).filter((item) =>
          !state.pending.some((pending) => item.kind === "message" && sameMessage(pending, item, MATCH_CHARS)));
        // The daemon's clock when it says, as with the catch-up read: the
        // transcript's rows are dated on it.
        state.liveStartedAt = message.startedAt ?? Date.now();
        state.panels = [];
        renderLive(true);
        renderPanels();
      }
    }
    if (message.type === "delta") {
      markThreadLive(message.threadId);
      state.lastDeltaAt = Date.now();
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
        state.live.push({ kind: "tool", id: message.id, name: message.name, summary: message.summary ?? "", args: message.args, at: message.at });
        renderLive();
      }
    }
    if (message.type === "panels") {
      markThreadLive(message.threadId);
      // Every producer's panels arrive together — store them, don't reduce them.
      if (active) {
        state.panels = message.panels ?? [];
        renderPanels();
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
      forgetThread(message.threadId);
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
      onWorkspacesView() ? render() : updatePairingBadge();
    }
  };
}

/** The daemon's overview over the snapshot's, without repainting the page. */
function refreshOverview() {
  cachedGet("/overview", { force: true }).then((overview) => {
    const painted = pairingIds(state.overview);
    state.overview = overview;
    keep("overview", overview);
    applyPairingBadge();
    // Except the one thing the badge counts: the workspaces view drew its
    // approve buttons from the snapshot's queue, not this one.
    if (onWorkspacesView() && pairingIds(overview) !== painted) render();
  }, () => {});
}
const pairingIds = (overview) => (overview?.pairing ?? []).map((request) => request.id).join();
const onWorkspacesView = () => routes[location.hash.replace("#/", "").split("/")[0]] === viewWorkspaces;

// Fetch a fresh overview, then repaint the badge (used when only the badge,
// not the whole view, needs to react — e.g. an incoming pairing request).
async function updatePairingBadge() {
  const overview = await cachedGet("/overview").catch(() => null);
  if (overview) state.overview = overview;
  applyPairingBadge();
}

async function onConfigChanged() {
  // A local save echoes back as config-changed; don't rebuild the view mid-edit.
  if (savesInFlight > 0) return;
  // Every view but the threads one renders from config.
  if (onThreadsView()) return;
  const fresh = await cachedGet("/config").catch(() => null);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.config)) render();
}

export { connectWs, refreshOverview };

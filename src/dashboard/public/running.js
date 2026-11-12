/* Which threads have a turn running, and the status line of the open one. */

import { elapsed, liveStatus } from "./live-turn.js";
import { state } from "./state.js";

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

/* The line under the transcript while a turn runs: a spinner, what the turn is
   doing, and how long it has been at it. The gap between "sent" and the first
   token used to look like a hang, and a long tool call still does — this is the
   page saying it is alive, and saying what it is busy with. */

function updateLiveStatus() {
  const row = document.getElementById("live-status");
  if (!row) return;
  row.querySelector(".live-status-label").textContent = liveStatus(state.live, { lastDeltaAt: state.lastDeltaAt });
  row.querySelector(".live-status-time").textContent = state.liveStartedAt ? elapsed(state.liveStartedAt) : "";
}

// The label ages on its own (prose stops, the clock ticks), so it is re-read
// once a second rather than only when an event happens to arrive.
setInterval(() => {
  if (state.activeThread && isThreadLive(state.activeThread.id)) updateLiveStatus();
}, 1000);

export { isThreadLive, markThreadLive, markThreadIdle, setServerRunning, seedRunning, updateLiveStatus };

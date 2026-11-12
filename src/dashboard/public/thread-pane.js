/* The conversation pane: reading a thread (and remembering the read), and
   painting the pane around its transcript.

   The threads view is mutually recursive by nature — the list opens a thread,
   opening one repaints the list, the pane's empty state opens the launcher,
   the launcher opens the thread it starts — so threads.js, thread-pane.js,
   thread-head.js, composer.js and launcher.js import each other. That is the
   only import cycle in the dashboard, and it is safe on one condition: these
   five use each other's bindings only inside functions called later, never
   while the module itself is being evaluated. */

import { keep } from "./snapshot.js";
import { state } from "./state.js";
import { api, call, ok, prefetch, started } from "./api.js";
import { ARROW_DOWN_ICON, atBottom, h, isPhone, withLoading } from "./ui.js";
import { channelSource, threadName, withoutChannelPrefix } from "./channels.js";
import { onThreadsView } from "./router.js";
import { stopRecording } from "./attachments.js";
import { isThreadLive, setServerRunning } from "./running.js";
import { durableRows, landed, onTranscriptScroll, renderLive, renderPanels, renderPending, scroller, scrollToBottom, updateJumpButton } from "./transcript.js";
import { backButton, openPaneMobile } from "./phone.js";
import { threadHeader } from "./thread-head.js";
import { threadComposer } from "./composer.js";
import { newThreadDialog } from "./launcher.js";
import { renderThreadList } from "./threads.js";

// Guards against an older /threads/:id response landing after a newer one (or
// after the reader moved on to another thread) and painting stale history.
let openSeq = 0;

/**
 * The last read of the conversations opened lately (and of the few at the top
 * of the list, read ahead while the page is idle) — what paneLoading paints
 * while the real read is on its way. Capped: a transcript can be large, and
 * this is a head start, not a copy of the daemon.
 */
const seenThreads = new Map(); // thread id → the /threads/:id answer
const SEEN_THREADS = 16;
function rememberThread(data, { persist = true } = {}) {
  seenThreads.delete(data.thread.id); // re-inserted as the newest
  seenThreads.set(data.thread.id, data);
  while (seenThreads.size > SEEN_THREADS) seenThreads.delete(seenThreads.keys().next().value);
  if (persist) keepSeen();
}
function forgetThread(id) {
  if (seenThreads.delete(id)) keepSeen();
}
// ...and across a cold start, through the snapshot. Without what the turn was
// doing: that part is never painted from memory, so it is not worth keeping.
const keepSeen = () => keep("seen", [...seenThreads.values()].map(({ live, ...read }) => read));

/** A read of the thread under a finger that has just landed, for the click it
 *  is probably about to be. A press that turns into a scroll opens nothing, so
 *  the answer is only held for a moment — left longer, it would be served,
 *  stale, to whichever open of that thread came next. */
function prefetchThread(id) {
  const path = `/threads/${id}`;
  if (started.has(path) || renderedThreadId === id) return;
  prefetch(path);
  const value = started.get(path);
  setTimeout(() => { if (started.get(path) === value) started.delete(path); }, 2000);
}

/** Read ahead the conversations at the top of the list — the ones a tap is
 *  most likely to open — once, when nothing else is waiting on the network. */
let readAhead = false;
function readAheadThreads() {
  if (readAhead || !isPhone()) return;
  readAhead = true;
  const idle = window.requestIdleCallback ?? ((run) => setTimeout(run, 1500));
  idle(async () => {
    for (const thread of state.threads.slice(0, 8)) {
      if (seenThreads.has(thread.id)) continue;
      const data = await call(`/threads/${thread.id}`).then(ok).catch(() => null);
      if (data && !seenThreads.has(thread.id)) rememberThread(data);
    }
  });
}

async function openThread(id) {
  const seq = ++openSeq;
  const epoch = state.liveEpoch;
  if (id !== state.activeThread?.id) {
    // Switching threads: nothing from the old one survives the move.
    state.live = [];
    state.liveStartedAt = 0;
    state.panels = [];
    state.pending = [];
  }
  // The pane stops showing what it was showing here, before the read — not
  // after it. Opening a thread is a tap and a round trip, and on a phone the
  // pane slides over the list on the tap: whatever it was holding rides in
  // with it for the length of the trip. Holding the launcher, that answers
  // "open this conversation" with a blank composer titled NEW THREAD.
  if (renderedThreadId !== id) paneLoading(id);
  // With the thread already on the pane — painted from its last read just now,
  // or simply the one being read — this read is a correction, not a wait: no
  // loading bar over content that is there, and no fading the page for it.
  const read = () => api.get(`/threads/${id}`).catch(() => null);
  const data = await (renderedThreadId === id ? read() : withLoading(read));
  if (!data || seq !== openSeq) {
    // A read that came back empty would otherwise leave the placeholder up for
    // good. Put back whatever the pane can still show — unless a newer open is
    // already painting it, in which case this one owns nothing anymore.
    if (!data && seq === openSeq) renderThreadPane();
    return false;
  }
  rememberThread(data);
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
  if (epoch === state.liveEpoch) {
    // No live turn means the turn is over and everything it produced is now in
    // the transcript. With one running, the server snapshot is only a catch-up
    // for a page that missed events — once we're receiving them ourselves, ours
    // is the complete record and the snapshot would lose the newest deltas.
    if (!data.live) {
      state.live = [];
      state.liveStartedAt = 0;
      // Panels outlive the turn on purpose: what a long run ended with is the
      // most useful thing on screen right after it.
    } else {
      // The daemon's clock, which is also the transcript's — so the cut-off it
      // gives is directly comparable with the rows' own timestamps.
      state.liveStartedAt = data.live.startedAt ?? state.liveStartedAt;
      if (!state.live.length) state.live = data.live.items ?? [];
      if (data.live.panels?.length) state.panels = data.live.panels;
    }
  }
  renderThreadPane();
  renderThreadList();
  return true;
}

// A message that arrives outside a turn (an operator send) has no turn-done to
// refresh on, so re-read the transcript shortly after any activity. Coalesced:
// a burst of events costs one read.
let reconcileTimer;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => state.activeThread && openThread(state.activeThread.id), 1500);
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
/** For the launcher, which takes the pane over without a render of it. */
/** Something else took the pane over (the launcher): whatever thread was drawn
 *  in it, header included, is gone. */
const forgetRenderedThread = () => {
  renderedThreadId = undefined;
  renderedHead = undefined;
};
/**
 * A transcript laid out while its pane is hidden has no height to scroll
 * through: asked for the bottom, it stays at the first message. A phone hits
 * that on every thread it has read before — paneLoading paints it on the tap,
 * and the slide only puts the pane on screen a frame later. The read that
 * lands after then finds the reader "scrolled up" and politely keeps them
 * there. So the wish is kept, and granted the moment the transcript has a size.
 */
let bottomOnShow = false;
const transcriptShown = new ResizeObserver(() => {
  const el = scroller();
  if (!bottomOnShow || !el?.clientHeight) return;
  bottomOnShow = false;
  el.scrollTop = el.scrollHeight;
  updateJumpButton();
});
// Everything the head paints. A topic can be renamed and a thread can change
// model mid-conversation, but neither happens on most re-renders —
// and rebuilding the head for nothing would snap a menu shut under the pointer.
let renderedHead;
const headSignature = (thread) =>
  `${threadName(thread)}|${thread.conversation}|${thread.workspace}|${thread.effectiveModel ?? thread.model}|${state.showRequests}`;

/**
 * The pane between a thread being asked for and its transcript arriving.
 *
 * Whatever it was holding — the launcher, the conversation read before this one
 * — reads as the answer to the click rather than as the wait for one, and on a
 * phone it arrives full-screen over the list at the moment of the tap. So the
 * pane is handed over here, before the read rather than after it.
 *
 * The card that was clicked already knows what it is called, so the head says
 * so immediately and only the transcript is waited for. It is a plain head, not
 * `threadHeader`: the real one carries a menu that acts on a record this pane
 * doesn't have yet.
 */
function paneLoading(id) {
  const pane = document.getElementById("thread-pane");
  if (!pane) return;
  stopRecording(); // the pane this replaces may have had one running
  // A conversation read before is painted as it was then, whole, and the read
  // in flight corrects it in place: a messenger opens a chat on the tap, not a
  // round trip later. Only the durable part — what the turn was doing then is
  // the one thing sure to be wrong now.
  const seen = seenThreads.get(id);
  if (seen) {
    state.activeThread = seen.thread;
    state.timeline = seen.timeline ?? [];
    state.requests = seen.requests ?? [];
    renderThreadPane();
    return;
  }
  renderedThreadId = undefined;
  renderedHead = undefined;
  pane.classList.remove("is-composing", "is-running");
  const card = state.threads.find((thread) => thread.id === id);
  pane.replaceChildren(
    // The head also keeps the way back: on a phone this is the whole screen,
    // and a read that stalls with no ‹ on it is a dead end.
    h("header", { class: "thread-head" },
      backButton(),
      h("div", { class: "thread-head-text min-w-0" },
        h("div", { class: "thread-head-title truncate" }, card ? threadName(card) : ""),
        h("div", { class: "thread-head-meta" },
          card ? channelSource(card.sessionKey) : null,
          h("span", { class: "truncate" }, card ? withoutChannelPrefix(card.conversation, card.sessionKey) : ""),
        ),
      ),
    ),
    h("div", { class: "pane-loading" }, h("i", { class: "spinner", "aria-hidden": "true" })),
  );
}

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
  const keepScroll = !opened && prev && !bottomOnShow && !atBottom(prev) ? prev.scrollTop : null;
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
          h("div", { class: "panel-board", id: "panels" }),
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
        h("span", { html: ARROW_DOWN_ICON }), "Latest", h("span", { class: "jump-count", hidden: true })),
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
  renderPanels();
  const messages = scroller();
  if (messages) {
    messages.scrollTop = keepScroll ?? messages.scrollHeight;
    bottomOnShow = keepScroll === null && !messages.clientHeight;
    if (opened) {
      transcriptShown.disconnect();
      transcriptShown.observe(messages);
    }
  }
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

export {
  seenThreads, rememberThread, forgetThread, prefetchThread, readAheadThreads, openThread,
  scheduleReconcile, forgetRenderedThread, renderThreadPane,
};

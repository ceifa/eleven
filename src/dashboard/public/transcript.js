/* The transcript of the open thread: its rows (messages, tool calls, buttons,
   panels), the three regions they are painted into, the optimistic bubbles of
   messages still in flight, and the "↓ Latest" pill. */

import { isButtonsCall, MATCH_CHARS, pressedData, pressPrompt, stateIcon, transcriptRows } from "./live-turn.js";
import { md } from "./markdown.js";
import { openLightbox } from "./lightbox.js";
import { presentMessage, sameMessage, splitEnvelope } from "./message-display.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { atBottom, FILE_ICON, h, isPhone, toast } from "./ui.js";
import { clock, dayLabel, fmtBytes, fmtTime } from "./format.js";
import { openModal, openRequestModal, openToolCallModal } from "./modals.js";
import { mediaName, mediaUrl } from "./attachments.js";
import { updateLiveStatus } from "./running.js";

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

// One tool call, rendered identically for the live row and the durable
// transcript — same markup, same place in the flow, so a reload mid-turn
// doesn't visibly rearrange the page. The arg preview is truncated to a single
// line by CSS; a row with a call id opens the modal with the full args and the
// recorded result. Live rows carry the same id the record is written under, so
// they're clickable while the turn runs — the result simply isn't there yet.
function toolCallRow({ name, summary, args, id, at }) {
  return h("div", {
    class: `tool-call${id ? " is-clickable" : ""}`,
    ...(id ? { title: "view arguments and result", onclick: () => openToolCallModal(name, args, id, at) } : {}),
  },
    h("span", { class: "tool-call-name" }, name),
    summary ? h("span", { class: "tool-call-arg" }, summary) : null,
    id ? h("span", { class: "tool-call-open", "aria-hidden": "true" }, "›") : null,
  );
}

/**
 * A run of consecutive tool calls, as its own transcript row — folded behind
 * one line on a phone, where twenty rows of monospace are a screen and a half
 * between a question and its answer. Open on a desktop, which has the room.
 *
 * The transcript is rebuilt on every reconcile, so a block the reader opened
 * or closed would snap back with each one. Their choice is kept by the block's
 * first call, which is also the key the live block and its durable copy share.
 */
const toolBlockChoice = new Map(); // first call id → open
function toolCallsBlock(calls) {
  const key = calls[0]?.id;
  const block = h("details", {
    class: "tool-calls",
    open: toolBlockChoice.get(key) ?? !isPhone(),
    ontoggle: () => { if (key) toolBlockChoice.set(key, block.open); },
  },
    h("summary", { class: "tool-calls-summary" }),
    h("div", { class: "tool-calls-list" }, calls.map(toolCallRow)),
  );
  summarizeToolCalls(block);
  return block;
}

/** "3 tool calls · Bash, Read" — the count and what kind of work it was. */
function summarizeToolCalls(block) {
  const names = [...block.querySelectorAll(".tool-call-name")].map((node) => node.textContent);
  const kinds = [...new Set(names)];
  const shown = kinds.slice(0, 3).join(", ") + (kinds.length > 3 ? ", …" : "");
  block.querySelector(".tool-calls-summary").replaceChildren(
    h("span", { class: "tool-calls-count" }, `${names.length} tool call${names.length === 1 ? "" : "s"}`),
    h("span", { class: "tool-calls-kinds" }, shown),
  );
}

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
    // On a phone a new tab is a different app (an installed eleven hands it to
    // the browser), so the picture opens over the thread instead.
    const open = (event) => { if (!isPhone()) return; event.preventDefault(); openLightbox(url, mediaName(id)); };
    return h("a", { class: "msg-media-frame", href: url, target: "_blank", rel: "noopener", onclick: open },
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
  const presented = presentMessage(message.text, state.showRequests);
  // ...and for the same reason it keeps the attribution lines where they were.
  const { envelope, text } = isUser && !state.showRequests ? splitEnvelope(presented.text) : { envelope: [], text: presented.text };
  const { media } = presented;
  return h("div", { class: `chat ${isUser ? "chat-end" : "chat-start"}${grouped ? " is-grouped" : ""}` },
    envelope.length ? h("div", { class: "msg-envelope" }, envelope.join(" · ")) : null,
    h("div", { class: `chat-bubble${streaming ? " msg-streaming" : ""}` },
      media.length ? h("div", { class: "msg-attachments" }, media.map(mediaAttachment)) : null,
      text ? h("div", { class: "msg-body", html: md(text) }) : null,
    ),
    at ? h("time", { class: "msg-time", datetime: new Date(at).toISOString() }, clock(at)) : null,
  );
}

/* A press is kept here until the transcript holds the reply that settles it:
   the block is rebuilt on every reconcile and must not come back clickable. */
const pressedButtons = new Map(); // call id → data

/** The agent's message with buttons under it, as Telegram draws an inline
 *  keyboard. `reply` is what the person said next, if anything — once there is
 *  one the buttons are spent, and the one it pressed keeps a tick. */
function buttonsMessage(call, reply) {
  const pressed = pressedData(reply) ?? pressedButtons.get(call.id);
  const spent = reply !== undefined || pressedButtons.has(call.id);
  const { text, buttons } = call.args;
  const node = h("div", { class: "chat chat-start" },
    text ? h("div", { class: "chat-bubble" }, h("div", { class: "msg-body", html: md(text) })) : null,
    h("div", { class: "msg-buttons" }, buttons.map((row) =>
      h("div", { class: "msg-buttons-row" }, row.map((button) => {
        if (button.url) return h("a", { class: "btn btn-sm", href: button.url, target: "_blank", rel: "noopener" }, button.label);
        const data = button.data ?? button.label;
        const taken = pressed === data;
        return h("button", {
          class: `btn btn-sm${taken ? " is-pressed" : ""}`,
          type: "button",
          disabled: spent,
          onclick: () => pressButton(call, data, node),
        }, taken ? `✓ ${button.label}` : button.label);
      })),
    )),
  );
  return node;
}

/** A press is a message from the person, sent the way the composer sends one. */
async function pressButton(call, data, node) {
  const threadId = state.activeThread.id;
  const text = pressPrompt(data);
  pressedButtons.set(call.id, data);
  const spent = buttonsMessage(call);
  node.replaceWith(spent);
  const bubble = showOutgoing({ role: "user", text });
  scrollToBottom();
  try {
    const delivered = await api.send("POST", `/threads/${threadId}/message`, { text });
    bubble.set(delivered.message ?? text);
  } catch (error) {
    toast(error.message, true);
    bubble.drop();
    pressedButtons.delete(call.id);
    spent.replaceWith(buttonsMessage(call));
  }
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
  if (row.kind === "buttons") return buttonsMessage(row.call, row.reply);
  if (row.kind === "error") return turnErrorRow(row.text);
  if (row.kind === "request") return requestChip(row.request, row.retry);
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
      if (item.kind === "tool" && !isButtonsCall(item) && previous?.classList.contains("tool-calls")) {
        previous.querySelector(".tool-calls-list").append(toolCallRow(item));
        summarizeToolCalls(previous);
      } else region.append(liveNode(item));
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
  if (item.kind === "tool") return isButtonsCall(item) ? buttonsMessage(item) : toolCallsBlock([item]);
  if (item.kind === "request") {
    if (!state.showRequests) return h("div", { hidden: true });
    const retry = state.live[state.live.indexOf(item) - 1]?.kind === "request";
    return requestChip({ id: item.id, model: item.model, at: item.at, bytes: 0 }, retry);
  }
  // A message that arrived mid-turn: an ordinary bubble, in the ordinary flow,
  // at the point in the turn where it actually landed.
  if (item.kind === "message") return messageBubble({ role: item.role, text: item.text }, { at: item.at });
  return messageBubble({ role: "assistant", text: item.text }, { streaming: true });
}

/* The panels the turn's producers publish, under the transcript. Not part of
   the live region: that region is a log that only grows, while this is state
   that gets replaced — rows that move from waiting to done as the work goes.
   It outlives the turn, because what a long run ended with is the most useful
   thing on screen right after it. */

function renderPanels() {
  const region = document.getElementById("panels");
  if (!region) return;
  sticky(() => region.replaceChildren(...state.panels.map(panelSection)));
}

function panelSection(panel) {
  return h("div", { class: "panel-section" },
    h("div", { class: "panel-section-title" }, panel.title),
    ...panel.rows.map(panelRow),
    panel.more ? h("div", { class: "panel-row panel-more" }, `… ${panel.more} more`) : null,
  );
}

function panelRow(row) {
  const opens = !!row.detail?.length;
  return h("div", {
    class: `panel-row is-${row.state}${opens ? " is-clickable" : ""}`,
    ...(opens ? { title: "view details", onclick: () => openRowDetail(row) } : {}),
  },
    h("span", { class: "panel-icon", "aria-hidden": "true" }, stateIcon(row.state)),
    h("span", { class: "panel-text" }, row.text),
    row.note ? h("span", { class: "panel-note" }, row.note) : null,
    opens ? h("span", { class: "panel-open", "aria-hidden": "true" }, "›") : null,
  );
}

function openRowDetail(row) {
  const body = h("div", { class: "row-detail" },
    ...row.detail.map(([label, value]) =>
      h("div", { class: "row-detail-row" },
        h("span", { class: "row-detail-label" }, label),
        h("span", { class: "row-detail-value font-mono" }, value),
      ),
    ),
  );
  openModal("Details", row.text, [], body);
}

// Deltas arrive dozens of times per second — coalesce to one render per frame.
let liveRaf;
function scheduleLiveRender() {
  liveRaf ??= requestAnimationFrame(() => {
    liveRaf = undefined;
    renderLive();
  });
}

/* The "↓ Latest" pill. It exists because the transcript follows a running turn
   only while the reader is at the bottom — scroll up to read something and the
   page correctly stops moving, but then nothing on screen says the conversation
   went on without you. */
/** How many messages were on screen when the reader left the bottom — what the
 *  pill counts the new ones against, the way a messenger's ↓ says "3". */
let messagesWhenAway;
const messageCount = () => document.querySelectorAll("#messages .chat").length;
function updateJumpButton() {
  const button = document.getElementById("jump-bottom");
  const el = scroller();
  if (!button || !el) return;
  const away = !atBottom(el);
  button.hidden = !away;
  if (away) messagesWhenAway ??= messageCount();
  else {
    messagesWhenAway = undefined;
    button.classList.remove("has-new");
  }
  paintUnreadCount(button);
}
function paintUnreadCount(button) {
  const badge = button.querySelector(".jump-count");
  const unread = messagesWhenAway === undefined ? 0 : Math.max(0, messageCount() - messagesWhenAway);
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? "99+" : String(unread);
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
  if (!button || !el || atBottom(el)) return;
  button.classList.add("has-new");
  paintUnreadCount(button);
}

/** One provider request, on its own line. `retry` marks a request sent again
 *  because the one above it brought nothing back. */
function requestChip(request, retry = false) {
  return h("button", {
    class: `request-chip font-mono text-xs${retry ? " is-retry" : ""}`,
    title: retry ? "retry of the request above, which brought nothing back · open the recorded request" : "open the recorded provider request",
    onclick: () => openRequestModal(request),
  },
    h("span", { class: "request-chip-mark", "aria-hidden": "true" }, retry ? "↻" : "⚡"),
    h("span", {}, [request.model, request.bytes ? fmtBytes(request.bytes) : null, fmtTime(request.at)].filter(Boolean).join(" · ")),
  );
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

export {
  landed, pushLiveMessage, showPending, withMediaNotes, scroller, durableRows, renderPending,
  renderLive, renderPanels, scheduleLiveRender, updateJumpButton, onTranscriptScroll,
  scrollToBottom, showOutgoing,
};

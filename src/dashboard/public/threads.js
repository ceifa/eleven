/* The threads view: its layout, and the list column — reading the list, the
   cards, the filters and the search box.

   Part of the threads view's one import cycle — see thread-pane.js. */

import { syncChildren } from "./dom.js";
import { keep } from "./snapshot.js";
import { state, view } from "./state.js";
import { api } from "./api.js";
import { FILTER_ICON, h, PLUS_ICON, SEARCH_ICON, toast, whenIdle } from "./ui.js";
import { timeAgo } from "./format.js";
import { channelSource, threadName } from "./channels.js";
import { syncPaneChrome } from "./chrome.js";
import { firstScreen, onThreadsView } from "./router.js";
import { isThreadLive, seedRunning } from "./running.js";
import { scrollToBottom } from "./transcript.js";
import { openPaneMobile, showPane } from "./phone.js";
import { openThread, prefetchThread, readAheadThreads, renderThreadPane, seenThreads } from "./thread-pane.js";
import { newThreadDialog } from "./launcher.js";

/* ---------- threads view ---------- */

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
  // The list a cold start paints first. Only the unfiltered one: a search is a
  // question, and opening the app on the answer to an old one would be wrong.
  if (!threadsQuery()) keep("threads", threads);
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
    thread.avatar?.src ?? null, thread.avatarColor ?? null,
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
      class: `card card-sm w-full ${older ? "is-older" : ""}`,
      // The full reading (channel · group · topic) is one hover away; the card
      // itself only has room for the part that identifies it.
      title: thread.conversation,
      // The read starts when the finger lands, not when it lifts: a tap is a
      // tenth of a second of that round trip already spent.
      onpointerdown: () => prefetchThread(thread.id),
      onclick: () => { openThread(thread.id); openPaneMobile(thread.id); },
    },
    h("div", { class: "card-body py-3 px-4" },
      threadAvatar(thread),
      h("div", { class: "thread-card-head flex items-center gap-2 text-sm" },
        channelSource(thread.sessionKey),
        h("span", { class: "truncate min-w-0" }, threadName(thread)),
        // Always in the markup, shown by CSS only on a live card: the halo says
        // "something is happening here" from the corner of your eye, and this
        // says it plainly. Painting it as a class keeps the card cacheable.
        h("i", { class: "spinner card-spinner", "aria-hidden": "true" }),
        h("span", { class: "ml-auto shrink-0 text-xs thread-meta", "data-since": thread.lastActivityAt }, timeAgo(thread.lastActivityAt)),
      ),
      h("div", { class: "thread-card-line flex items-center gap-2 text-xs thread-meta" },
        h("span", { class: "thread-card-workspace shrink-0" }, thread.workspace),
        h("span", { class: "thread-card-title truncate min-w-0" }, thread.title ?? "(untitled)"),
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

/**
 * A face for a conversation on a phone, where the list is rows rather than
 * cards and a column of names needs something to land the eye on. It is the
 * face Telegram gives it where there is one — the group's or the person's
 * photo, a topic's emoji — laid over the initial, which is what shows while it
 * loads and what stays when there is none. A topic's initial sits on the
 * topic's own colour, as in Telegram; anything else takes a hue fixed by its
 * session key, so a group keeps its colour across every generation of its
 * threads. The channel rides along as a badge in the corner. Hidden on a
 * desktop, whose cards already carry the glyph at the head of the name.
 */
function threadAvatar(thread) {
  const name = threadName(thread);
  const initial = name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "·";
  let hash = 0;
  for (const char of thread.sessionKey) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const style = thread.avatarColor ? `--tint:${thread.avatarColor}` : `--hue:${hash % 360}`;
  return h("span", { class: `thread-avatar ${thread.avatarColor ? "is-tinted" : ""}`, style, "aria-hidden": "true" },
    initial,
    thread.avatar
      ? h("img", {
        class: `avatar-picture is-${thread.avatar.kind}`,
        src: thread.avatar.src,
        alt: "",
        loading: "lazy",
        decoding: "async",
        onload: (event) => event.currentTarget.classList.add("is-loaded"),
        // No picture (a 404, or a bot that is down): the initial underneath
        // was the answer all along.
        onerror: (event) => event.currentTarget.remove(),
      })
      : null,
    channelSource(thread.sessionKey),
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

/* The column is built a screenful at a time. The first time a card is drawn it
   is styled and laid out whole, on screen or not, and five hundred of them at
   once are most of what a cold start spends before it can be touched — for a
   list of which a dozen rows are in view, or, on a phone that opens on the
   launcher, none. So the first rows are drawn now and the rest follow in
   pieces while the page is idle; a moment later the whole list is there to
   scroll. The count only grows: a card already drawn is kept (cardCache), and
   putting it back costs nothing like drawing it did. */
const FIRST_LIST_ROWS = 30;
const MORE_LIST_ROWS = 40;
let listRows = FIRST_LIST_ROWS;
let listGrowing = false;
function growThreadList() {
  if (listGrowing) return;
  listGrowing = true;
  whenIdle(() => {
    listGrowing = false;
    listRows += MORE_LIST_ROWS;
    renderThreadList();
  });
}

function renderThreadList() {
  const list = document.getElementById("thread-list");
  if (!list) return;
  renderThreadFilters();
  const rows = [];
  const shown = new Set();
  const groups = new Set();
  let more = false;
  for (const group of groupThreads(state.threads)) {
    if (rows.length >= listRows) {
      more = true;
      break;
    }
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
  if (more) growThreadList();
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

/** No page title here: the sidebar already says which view this is, and the
 *  list is the whole page. What's left above the threads is one search row and,
 *  only when there is something to choose between, a line of quiet filters. */
async function viewThreads() {
  // A list this page already holds — the snapshot a cold start restored, or
  // the one it read before visiting another tab — is painted now and corrected
  // when the read lands. Only a page with nothing to show waits for it.
  const reading = refreshThreads();
  if (!state.threads.length) await reading;
  renderedFilters = ""; // the markup below is a fresh DOM — the filters have to be built into it again
  view.replaceChildren(
    h("div", { class: "threads-layout flex", id: "threads-layout" },
      h("div", { class: "threads-list-col shrink-0 flex flex-col gap-2" },
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
        h("div", { class: "flex flex-col overflow-y-auto thread-scroll", id: "thread-list" }),
      ),
      h("div", { class: "flex-1 min-w-0 flex flex-col", id: "thread-pane" }),
    ),
  );
  // A layout just built is showing its list, whatever the one before it showed.
  syncPaneChrome();
  renderThreadList();
  readAheadThreads();
  // #/threads/<id> names a thread directly — a reload, a bookmark, a link from
  // the Usage page. It wins over whatever was last open here.
  const requested = location.hash.replace("#/", "").split("/")[1];
  // Arriving with nothing open means you came here to say something. The
  // launcher is the landing page, then — an empty pane whose only offer is a
  // button to the launcher was one click of ceremony in front of every session.
  if (requested || state.activeThread) {
    renderThreadPane();
    const id = requested ?? state.activeThread.id;
    // A conversation read before is on screen the moment openThread starts
    // (paneLoading paints it); the read that corrects it doesn't get to hold
    // the page — or fade it, as a route still loading does.
    const painted = seenThreads.has(id);
    // A URL that names a thread is a request to read it, so on a phone it opens
    // the conversation rather than the list it is buried in. No history entry:
    // this *is* the entry — a back from here belongs to whatever came before
    // eleven, not to a list the reader never saw. Shown before it is painted
    // when it can be: a pane painted while hidden has no height to scroll to
    // the bottom of, and opens on the top of the thread.
    if (painted && requested) showPane();
    // A link to a thread that has since been collected falls back to the
    // launcher rather than to an empty pane.
    const opening = openThread(id).then((opened) => {
      if (!opened) newThreadDialog();
      return opened;
    });
    if (!painted && (await opening) && requested) {
      showPane();
      scrollToBottom();
    }
  } else {
    newThreadDialog();
    // A phone shows one half at a time, and it used to open on the list, a tap
    // away from the box. Opening the app is the same "came here to say
    // something" as on a desktop, so it lands on the launcher; coming back to
    // Threads from another tab is looking for a thread, and gets the list. No
    // history entry, as with a deep link: the ‹ and the swipe close it the same.
    if (firstScreen) showPane();
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

export { threadsQuery, refreshThreads, scheduleThreadRefresh, renderThreadList, viewThreads };

/* The head of an open thread: its name and meters, the ⋯ menu, and what the
   menu does (a fresh thread, skills, delete).

   Part of the threads view's one import cycle — see thread-pane.js. */

import { drafts, prefs, state } from "./state.js";
import { api } from "./api.js";
import { copyText, h, isPhone, toast } from "./ui.js";
import { fmtMoney, fmtPercent, fmtTokens } from "./format.js";
import { channelSource, threadName, withoutChannelPrefix } from "./channels.js";
import { openSkillsModal } from "./modals.js";
import { backButton, closePaneMobile, openPaneMobile } from "./phone.js";
import { forgetThread, openThread, renderThreadPane } from "./thread-pane.js";
import { refreshThreads } from "./threads.js";

/* The head of the conversation: what you are reading on the first line, where
   it lives on the second, and the controls that act on it at the far end.
   `delete` is deliberately not one of them — it hides behind the ⋯, because the
   most destructive button on the page had been sitting one stray click away
   from the scrollbar. */
function threadHeader(thread) {
  const model = thread.effectiveModel ?? thread.model;
  return h("header", { class: "thread-head" },
    backButton(),
    h("div", {
      class: "thread-head-text min-w-0",
      // On a phone the pill is the way into the thread's details, as a
      // messenger's name at the top of a chat is. Stopped here, or the
      // document's own listener takes the click for one outside the menu and
      // shuts it again on the same tick.
      onclick: (event) => {
        if (!isPhone()) return;
        event.stopPropagation();
        const menu = event.currentTarget.closest(".thread-head")?.querySelector(".thread-menu");
        if (menu) menu.open = true;
      },
    },
      h("div", { class: "thread-head-title truncate" }, threadName(thread)),
      h("div", { class: "thread-head-meta" },
        channelSource(thread.sessionKey),
        // The conversation in words; the raw session key stays one hover away.
        h("span", { class: "truncate", title: thread.sessionKey }, withoutChannelPrefix(thread.conversation, thread.sessionKey)),
        h("span", { class: "meta-sep" }, "·"),
        h("span", { class: "text-warning shrink-0" }, thread.workspace),
        // A phone's head has room for where the thread lives and whether it is
        // working, and nothing else: the model and the meter go to the desktop.
        h("span", { class: "head-working" }, "working"),
        model ? h("span", { class: "meta-sep hide-mobile" }, "·") : null,
        model ? h("span", { class: "font-mono truncate hide-mobile", title: "model leading this thread" }, model) : null,
        ...threadUsageMeta(thread.usage),
      ),
    ),
    h("div", { class: "thread-head-actions" },
      // Says the same thing the sign in the sidebar does, at the one place a
      // reader of this thread is already looking.
      h("span", { class: "running-pill" }, h("i", { class: "spinner" }), "running"),
      h("button", {
        class: `toolbar-icon hide-mobile${state.showRequests ? " is-active" : ""}`,
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
    h("span", { class: "meta-sep hide-mobile" }, "·"),
    h("span", {
      class: "shrink-0 hide-mobile",
      title: `${prompt.toLocaleString()} prompt + ${usage.output.toLocaleString()} output tokens · list price ${fmtMoney(usage.cost)}`,
    }, parts.join(" · ")),
  ];
  if (fill !== undefined) {
    nodes.push(h("span", { class: "meta-sep hide-mobile" }, "·"));
    nodes.push(h("span", {
      class: `shrink-0 hide-mobile${fill >= 0.85 ? " text-error" : fill >= 0.6 ? " text-warning" : ""}`,
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
  const info = h("div", { class: "sheet-info mobile-only" });
  const menu = h("details", {
    class: "thread-menu",
    // Read on the way open, not when the head was built: the head is kept
    // across turns, and what a thread has burned moves with every one of them.
    ontoggle: () => { if (menu.open && isPhone()) info.replaceChildren(...sheetInfo(state.activeThread ?? thread)); },
  },
    h("summary", { class: "toolbar-icon", title: "more", "aria-label": "More actions" }, "⋯"),
    h("div", { class: "thread-menu-body" },
      info,
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
      // The ⚡ in the head, on a phone whose head has no room for it.
      h("button", {
        class: "menu-item mobile-only",
        onclick: () => { menu.open = false; toggleRequests(); },
      }, state.showRequests ? "Hide diagnostics" : "Show diagnostics"),
      h("button", { class: "menu-item", onclick: () => { menu.open = false; copyText(id, "Thread id copied."); } }, "Copy thread id"),
      deleteThreadButton(id),
    ),
  );
  return menu;
}

/**
 * The head of the ⋯ sheet on a phone: what the desktop's head line says and a
 * phone's head has no room for — where the thread lives, the model leading it,
 * and what it has burned. The "contact info" of a messenger, for a thread.
 */
function sheetInfo(thread) {
  const row = (label, value, tone = "") =>
    h("div", { class: "sheet-info-row" },
      h("span", { class: "sheet-info-label" }, label),
      h("span", { class: `sheet-info-value${tone}` }, value));
  const rows = [
    h("div", { class: "sheet-info-title" }, threadName(thread)),
    row("Lives in", thread.conversation),
    row("Workspace", thread.workspace, " text-warning"),
  ];
  const model = thread.effectiveModel ?? thread.model;
  if (model) rows.push(row("Model", model, " font-mono"));
  const usage = thread.usage;
  if (usage) {
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    rows.push(row("Tokens", `${fmtTokens(prompt + usage.output)}${prompt ? ` · ${fmtPercent(usage.cacheRead / prompt)} cached` : ""} · ${fmtMoney(usage.cost)}`));
    if (usage.contextWindow) {
      const fill = usage.lastPromptTokens / usage.contextWindow;
      rows.push(row("Context", `${fmtPercent(fill)} of ${fmtTokens(usage.contextWindow)}`, fill >= 0.85 ? " text-error" : fill >= 0.6 ? " text-warning" : ""));
    }
  }
  return rows;
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
    // The details itself is the target only through its backdrop — the dark
    // behind a phone's sheet, which is a click on nothing.
    if (!open.contains(event.target) || event.target === open) open.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const open of document.querySelectorAll("details.thread-menu[open]")) open.open = false;
});

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
  forgetThread(id);
  // The thread-deleted broadcast also lands here, but don't depend on the
  // socket being healthy to clear the pane we're looking at.
  if (state.activeThread?.id === id) {
    state.activeThread = null;
    renderThreadPane();
    closePaneMobile();
  }
  refreshThreads();
}

export { threadHeader };

/* The launcher: the pane as the first message of a thread that doesn't exist yet.

   Part of the threads view's one import cycle — see thread-pane.js. */

import { drafts, NEW_THREAD_DRAFT, prefs, state } from "./state.js";
import { api } from "./api.js";
import { h, toast } from "./ui.js";
import { syncPaneChrome } from "./chrome.js";
import { composerAttachments, stopRecording } from "./attachments.js";
import { backButton, closePaneMobile } from "./phone.js";
import { autoGrow, sendsOnEnter } from "./composer.js";
import { forgetRenderedThread, openThread, renderThreadPane } from "./thread-pane.js";
import { refreshThreads, renderThreadList } from "./threads.js";

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
  forgetRenderedThread();
  pane.classList.remove("is-running");
  pane.classList.add("is-composing");
  syncPaneChrome();

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
              h("span", { class: "font-mono text-xs" }, workspace ?? "none configured"),
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

export { newThreadDialog };

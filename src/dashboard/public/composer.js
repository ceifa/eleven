/* The composer under an open thread: the box, sending, and stopping a turn.

   Part of the threads view's one import cycle — see thread-pane.js. */

import { drafts, state } from "./state.js";
import { api } from "./api.js";
import { h, isPhone, SEND_ICON, toast } from "./ui.js";
import { composerAttachments } from "./attachments.js";
import { scrollToBottom, showOutgoing, withMediaNotes } from "./transcript.js";
import { newThreadDialog } from "./launcher.js";

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

export { autoGrow, threadComposer, sendsOnEnter };

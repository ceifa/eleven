/* The phone, where the thread list and a conversation are two screens: moving
   between them, the swipe back, and a viewport the keyboard slides over. */

import { syncPaneChrome } from "./chrome.js";
import { navDrag } from "./nav-drag.js";
import { h, isPhone } from "./ui.js";
import { scrollToBottom } from "./transcript.js";

// On mobile the list and the conversation share one screen; these swap between
// them (a no-op on desktop, where both panes are always visible side by side).
const threadsLayout = () => document.getElementById("threads-layout");
/** The one place the pane's class changes, so the chrome hears of it at once. */
function markPane(open) {
  threadsLayout()?.classList.toggle("pane-open", open);
  syncPaneChrome();
}
const showPane = () => markPane(true);

/**
 * Open the conversation pane over the list — and, on a phone, record that as a
 * navigation.
 *
 * Two screens the reader moves between are two history entries, or the back
 * gesture means "leave eleven" the whole time a thread is open. Installed as an
 * app that is worse still: Android's back button is the only one there is, and
 * it would close the app rather than return to the list. The entry carries a
 * `pane` marker so a back that lands *outside* it (a deep link opened cold) can
 * be told from one this page pushed.
 */
function openPaneMobile(threadId) {
  const layout = threadsLayout();
  if (!layout) return;
  if (isPhone() && !layout.classList.contains("pane-open")) {
    history.pushState({ pane: true }, "", threadId ? `#/threads/${threadId}` : "#/threads");
  }
  setPane(true);
}

/** Back to the list. Through history when the pane got there through history,
 *  so the ‹ button and the back gesture leave the same trail behind them. */
function closePaneMobile() {
  const layout = threadsLayout();
  if (!layout?.classList.contains("pane-open")) return;
  if (history.state?.pane) return history.back(); // the popstate listener in app.js drops the class
  setPane(false);
}
// The launcher keeps the tab bar, and its route already is #/threads: the link
// alone changes nothing, so the tap on Threads is what goes back to the list.
document.querySelector('.tabbar a[data-view="threads"]').addEventListener("click", (event) => {
  if (!threadsLayout()?.classList.contains("pane-open")) return;
  event.preventDefault();
  closePaneMobile();
});

// Mobile-only ‹ that returns from the conversation/compose pane to the list.
const backButton = () =>
  h("button", { class: "btn btn-ghost btn-sm mobile-only px-2", "aria-label": "Back to threads", onclick: closePaneMobile },
    h("span", { html: "‹", style: "font-size:1.3rem;line-height:1" }));

/* ---------- the phone: sliding between screens, and the way back ---------- */

/**
 * On a phone the list and a conversation are two screens, and moving between
 * them slides: the conversation comes in from the right over the list and goes
 * back out the way it came. A cut between two screens that look alike reads as
 * the page flickering, not as going somewhere.
 *
 * A view transition rather than two panes kept side by side and translated:
 * the two screens are not the same shape — the list has the top bar and the tab
 * bar, the conversation has neither — and a snapshot slides whatever shape it
 * is. A browser without view transitions gets the cut it always had.
 */
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function slide(direction, mutate) {
  if (!isPhone() || reducedMotion.matches || !document.startViewTransition) return mutate();
  const root = document.documentElement;
  root.dataset.slide = direction;
  document.startViewTransition(mutate).finished.finally(() => {
    if (root.dataset.slide === direction) delete root.dataset.slide;
  });
}

/** Where the pane is headed while a slide is carrying it there. Going back
 *  through history fires popstate and then hashchange, and both of them say
 *  "close": the second must not start a slide of its own. */
let paneHeading;
function setPane(open, { animate = true } = {}) {
  const layout = threadsLayout();
  if (!layout) return;
  if ((paneHeading ?? layout.classList.contains("pane-open")) === open) return;
  paneHeading = open;
  const apply = () => {
    paneHeading = undefined;
    markPane(open);
  };
  if (animate) slide(open ? "forward" : "back", apply);
  else apply();
}

/* And the conversation follows the finger back to the list: a drag from the
   left edge pulls it off to the right with the list sliding in under it, the
   way a phone's own back gesture does. An installed app has no browser gesture
   to lean on, and the ‹ sits in the corner a thumb reaches last. The gesture is
   the same state machine the drawer used to run on; here "open" is the list. */
const swipe = navDrag();
/** Something the finger could be scrolling sideways instead — a code block, a
 *  wide table. It was there first; the gesture doesn't get to take it. */
function scrollsSideways(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") return true;
  }
  return false;
}
/** Hand the position to CSS. While this class is on, the pane sits wherever the
 *  finger left it and nothing animates. */
const paintSwipe = (progress) => {
  document.body.classList.add("swiping-back");
  document.body.style.setProperty("--back", String(progress));
};
const dropSwipe = () => {
  document.body.classList.remove("swiping-back", "swipe-settling");
  document.body.style.removeProperty("--back");
};
/** Let go: the pane glides the rest of the way — off, or back into place — and
 *  only once it is there does the list become the screen for real. */
function settleSwipe(back) {
  const body = document.body;
  body.classList.add("swipe-settling");
  body.style.setProperty("--back", back ? "1" : "0");
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (back) {
      // Closed here, directly, rather than through setPane: the finger already
      // did the sliding. popstate and hashchange then find nothing left to do.
      markPane(false);
      if (history.state?.pane) history.back();
    }
    dropSwipe();
  };
  document.getElementById("thread-pane")?.addEventListener("transitionend", finish, { once: true });
  setTimeout(finish, 400); // a transition that never ran never ends
}
document.addEventListener("touchstart", (e) => {
  const open = threadsLayout()?.classList.contains("pane-open");
  const busy = document.body.classList.contains("swipe-settling") || document.querySelector(".lightbox");
  // The outermost 20px belong to native back; never paint a second swipe there.
  if (!isPhone() || !open || e.touches.length > 1 || busy || e.touches[0].clientX <= 20) {
    swipe.cancel();
    return;
  }
  const width = window.innerWidth;
  const started = swipe.start({ x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, open: false, drawer: width, screen: width });
  if (started && scrollsSideways(e.target)) swipe.cancel();
}, { passive: true });
// Non-passive: a pane that follows the finger has to stop the transcript
// scrolling under it, and preventDefault from a passive listener is ignored.
document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1 || !e.cancelable) { swipe.cancel(); dropSwipe(); return; }
  const at = swipe.move({ x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp });
  if (!at) return;
  e.preventDefault();
  paintSwipe(at.progress);
}, { passive: false });
document.addEventListener("touchend", () => {
  const settled = swipe.end();
  if (settled) settleSwipe(settled.open);
});
document.addEventListener("touchcancel", () => {
  swipe.cancel();
  dropSwipe();
});

/* ---------- the phone's viewport ---------- */

// dvh knows about the browser's own bars but not about the on-screen keyboard:
// iOS slides that over the page instead of resizing the page, so the composer
// ends up behind the keys while the transcript still claims the whole screen.
// The visual viewport is the part actually visible, and the difference between
// it and the window is what the keyboard is covering — style.css subtracts
// --keyboard from the threads screen's height. Where the browser does resize
// the layout instead (most Android ones), the difference is zero and this
// costs nothing.
const viewport = window.visualViewport;
if (viewport) {
  let covered = 0;
  const measure = () => {
    // offsetTop counts the page the browser scrolled up to reveal the focused
    // field: those pixels are hidden by the keyboard just the same.
    const next = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    if (Math.abs(next - covered) < 2) return; // sub-pixel jitter while a bar animates
    const opening = next > covered;
    covered = next;
    document.documentElement.style.setProperty("--keyboard", `${next}px`);
    // Typing shouldn't bury the message you are answering.
    if (opening) requestAnimationFrame(() => scrollToBottom());
  };
  viewport.addEventListener("resize", measure);
  viewport.addEventListener("scroll", measure);
  measure();
}

// Nothing here scrolls the document — every pane owns its own scroller — but a
// phone scrolls it anyway: iOS moves the window to bring a focused field above
// the keyboard and, since iOS 26, can leave it there after the keyboard is
// gone. The fixed chrome is then placed against a viewport that is no longer
// the screen, and the tab bar floats over a strip of nothing until a drag
// scrolls the page home. That drag, done for the reader: whenever the document
// is found off its origin and no field is taking keys, it goes back to 0.
const typing = () => document.activeElement?.matches("input, textarea, select, [contenteditable]") ?? false;
function homeDocument() {
  if (typing()) return;
  // Pinch-zoomed, an offset visual viewport is the reader looking around.
  const zoomed = viewport && viewport.scale > 1.01;
  if (window.scrollY || window.scrollX || (!zoomed && viewport?.offsetTop)) window.scrollTo(0, 0);
}
// focusout fires before focus lands anywhere else: a tap from one field to the
// next must not bounce the page in between.
document.addEventListener("focusout", () => setTimeout(homeDocument, 50));
window.addEventListener("scroll", homeDocument, { passive: true });
viewport?.addEventListener("resize", homeDocument);
window.addEventListener("pageshow", homeDocument);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && homeDocument());

export { threadsLayout, showPane, openPaneMobile, closePaneMobile, backButton, setPane };

/* What every view builds with: the element builder, toasts, the icons, the
   phone breakpoint, the labelled-field bits of the config pages, and the route
   loading bar. */

import { view } from "./state.js";

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

const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="m10.3 10.3 3.2 3.2"/></svg>`;
const PLUS_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>`;
const FILTER_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/></svg>`;
const SEND_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13.2V3.4M4 7.2 8 3.2l4 4"/></svg>`;
const ARROW_DOWN_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2v9.4M4.2 8.8 8 12.6l3.8-3.8"/></svg>`;
const CLIP_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.8 7.3 6.6 11.5a2 2 0 0 1-2.9-2.8l5-5a3.1 3.1 0 0 1 4.4 4.4l-5 5a4.2 4.2 0 0 1-6-6l4.3-4.3"/></svg>`;
const MIC_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3.4 8.4 3.1 3.1 6.1-6.9"/></svg>`;
const X_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/></svg>`;

/** Run `work` when the page has a moment to itself — for what the screen is not
 *  waiting on. A browser without idle callbacks gets a short timer instead. */
const whenIdle = window.requestIdleCallback ?? ((work) => setTimeout(work, 60));

// Is the scroll container within a hair of the bottom? Used to decide whether
// live updates should follow along or leave the reader where they scrolled to.
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;

// Play a one-shot animation class, replaying from the top if it's mid-flight,
// and clear the class when the animation ends. Mid-flight it is wound back
// where it stands: dropping the class and forcing a reflow to make the browser
// notice restarts it too, but this is called for every event of a streaming
// turn, and a reflow of the page per event is a turn's worth of layout.
function flare(el, cls) {
  if (el.classList.contains(cls)) {
    // subtree: the class may animate what is inside the element (a bulb and
    // its glow), not the element itself.
    for (const animation of el.getAnimations({ subtree: true })) animation.currentTime = 0;
    return;
  }
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

const copyText = (text, message) => navigator.clipboard.writeText(text).then(() => toast(message), () => toast("Could not copy.", true));

// Mirrors the `max-width: 768px` breakpoint in style.css — no build step here
// to share a constant, so the two have to be kept in sync by hand.
const phoneQuery = matchMedia("(max-width: 768px)");
const isPhone = () => phoneQuery.matches;

/* ---------- shared bits ---------- */

/** `actions` ride on the title's own line, which is where a control that
 *  belongs to the whole page goes instead of into a row of its own. */
function pageTitle(title, ...actions) {
  return h("div", { class: "mb-6 flex items-center gap-3 flex-wrap" },
    h("h1", { class: "page-title" }, title),
    ...actions,
  );
}

const sectionLabel = (text) => h("div", { class: "section-label" }, text);

const INFO_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="info"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7.2" x2="8" y2="11.2"/><circle cx="8" cy="4.7" r="0.9" fill="currentColor" stroke="none"/></svg>`;

/** The ⓘ — the place for the longer explanation the label doesn't need. A
 *  button rather than a span so a finger can reach it: nothing hovers on a
 *  phone, and the tip also shows on focus (.tooltip:focus in style.css). */
const info = (tip) => h("button", { type: "button", class: "tooltip tooltip-right info-icon", "data-tip": tip, "aria-label": tip, html: INFO_ICON });

function labeled(label, control, tip) {
  // The visible label is a div beside the field, which names it for the eye
  // and for nothing else. Give the field the same words.
  if (control?.matches?.("input, select, textarea") && !control.hasAttribute("aria-label")) control.setAttribute("aria-label", label);
  return h("div", {},
    h("div", { class: "text-xs dim-label mb-1 flex items-center gap-1.5" }, label, tip ? info(tip) : null),
    control,
  );
}

/**
 * A button that removes something, and takes two clicks to do it: the first
 * arms it, the second commits, and four seconds of nothing disarms it again.
 *
 * Removing a workspace takes its channels with it, a channel its people and
 * groups, a group its topics — and every one of those was a single click on a
 * word in the corner of a row, saved the moment it landed. No native
 * confirm(): a modal dialog would block scripted browsers.
 *
 * `loud` keeps it red at rest, for the one remove on a page that stands alone.
 */
function confirmButton(label, action, { class: extra = "", noun, loud = false } = {}) {
  let armedAt = 0;
  let timer;
  const disarm = () => {
    clearTimeout(timer);
    armedAt = 0;
    button.textContent = label;
    button.classList.remove("is-armed");
  };
  const button = h("button", {
    type: "button",
    class: `btn btn-ghost btn-xs text-error${loud ? " is-loud" : ""} ${extra}`,
    title: noun ? `remove ${noun}` : undefined,
    onclick: async () => {
      if (!armedAt) {
        armedAt = Date.now();
        button.textContent = "Confirm removal";
        button.classList.add("is-armed");
        timer = setTimeout(disarm, 4000);
        return;
      }
      // The armed button sits where the resting one was, so the second half
      // of a double-click lands on it. That is not a decision.
      if (Date.now() - armedAt < 500) return;
      // Disarmed before it runs, and dead while it does: a save that fails
      // must not leave a live trigger behind, and a third click must not
      // remove the next row that slid into this one's place.
      disarm();
      button.disabled = true;
      try { await action(); } finally { button.disabled = false; }
    },
  }, label);
  return button;
}

// A fold is a checkbox laid over its title, so Space opens it and Enter — the
// key everything else on the page answers to — did nothing.
document.addEventListener?.("keydown", (event) => {
  if (event.key === "Enter" && event.target?.matches?.(".collapse > input[type=checkbox]")) event.target.click();
});

/* ---------- route loading indicator ---------- */

// Painting a view means fetching first, so a sidebar click can spend a few
// hundred milliseconds looking like nothing happened. The bar (styled in
// style.css) says "heard you" — after a short delay, because a route that
// resolves quickly would flash it and read as a glitch rather than as feedback.
// Loads can overlap (a config poll landing mid-navigation), so a depth counter
// owns the state: the bar clears when the last one finishes, not the first.
const LOADING_DELAY_MS = 150;
let loadingDepth = 0;
let loadingTimer;

function beginLoading(swap) {
  if (++loadingDepth > 1) return;
  loadingTimer = setTimeout(() => {
    document.body.classList.add("is-loading");
    // Only a whole-page swap fades the view out. A load that replaces one part
    // of the page (opening a thread) leaves the rest at full strength — it is
    // still the current, clickable page.
    if (swap) document.body.classList.add("is-swapping");
  }, LOADING_DELAY_MS);
  view.setAttribute("aria-busy", "true");
}

function endLoading() {
  if (--loadingDepth > 0) return;
  loadingDepth = 0;
  clearTimeout(loadingTimer);
  document.body.classList.remove("is-loading", "is-swapping");
  view.removeAttribute("aria-busy");
}

/** Runs `work` with the loading bar armed, whatever it does or throws. */
async function withLoading(work, { swap = false } = {}) {
  beginLoading(swap);
  try { return await work(); } finally { endLoading(); }
}

export {
  h, toast, SEARCH_ICON, PLUS_ICON, FILTER_ICON, SEND_ICON, ARROW_DOWN_ICON, CLIP_ICON, MIC_ICON,
  CHECK_ICON, X_ICON, FILE_ICON, whenIdle, atBottom, flare, copyText, isPhone, pageTitle, sectionLabel, info,
  labeled, confirmButton, withLoading,
};

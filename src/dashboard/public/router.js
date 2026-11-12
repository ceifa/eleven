/* The router: which view the address bar names, and painting it. The views
   sit above this module and call back into it to repaint, so the route table
   is filled in by app.js rather than imported here. */

import { keep } from "./snapshot.js";
import { state, view } from "./state.js";
import { cachedGet, signIn, SignInExpired } from "./api.js";
import { h, withLoading } from "./ui.js";
import { applyPairingBadge } from "./chrome.js";

/* ---------- router ---------- */

const onThreadsView = () => location.hash.startsWith("#/threads") || location.hash === "" || location.hash === "#/";

/** Route name → view. Filled in by app.js: the views import this module to
 *  repaint, so it cannot import them. */
const routes = {};
/** Whether the route being rendered is the one the page was opened on. */
let firstScreen = true;

async function render() {
  const name = (location.hash.replace("#/", "") || "threads").split("/")[0];
  const route = routes[name] ?? routes.threads;
  for (const link of document.querySelectorAll("aside .menu a, .tabbar a")) {
    link.classList.toggle("menu-active",
      (link.dataset.view === name)
      || (name === "channels" && link.dataset.view === "workspaces")
      || (name === "providers" && link.dataset.view === "models"));
  }
  // Collapse sections are checkbox-driven, so a structural re-render (any
  // config save that rebuilds the view) would slam them all shut. Snapshot
  // which ones are open and reopen them after the rebuild — stale ids (a
  // removed row, another page) simply match nothing.
  const openCollapses = [...view.querySelectorAll(".collapse[data-collapse]")]
    .filter((el) => el.querySelector(":scope > input:checked"))
    .map((el) => el.dataset.collapse);
  try {
    await withLoading(async () => {
      state.overview = await cachedGet("/overview");
      keep("overview", state.overview);
      applyPairingBadge();
      await route();
      firstScreen = false;
    }, { swap: true });
  } catch (error) {
    view.replaceChildren(loadFailure(error));
  }
  for (const id of openCollapses) {
    const input = view.querySelector(`.collapse[data-collapse="${CSS.escape(id)}"] > input`);
    if (input) input.checked = true;
  }
}

/**
 * The view when the first read of a page fails.
 *
 * Worth its own shape now that the shell is cached: an installed eleven opens
 * on a train with no signal and paints perfectly, and then every number on it
 * is missing. "Failed to fetch" reads as a bug in the page; the page is fine,
 * and what is actually wrong — no network, or a daemon that isn't running — is
 * two different problems with two different fixes.
 */
function loadFailure(error) {
  if (error instanceof SignInExpired) {
    return h("div", { class: "flex flex-col gap-3 self-start" },
      h("div", { class: "alert alert-error" }, "Your sign-in to this dashboard has expired."),
      h("button", { class: "btn btn-sm self-start", onclick: () => signIn({ force: true }) }, "Sign in"),
    );
  }
  const offline = !navigator.onLine;
  const unreachable = offline || error instanceof TypeError; // fetch rejects with a TypeError
  return h("div", { class: "flex flex-col gap-3 self-start" },
    h("div", { class: "alert alert-error" },
      offline ? "This device is offline. The interface is cached; the conversations in it are not."
        : unreachable ? "Can't reach the eleven daemon — check that it is running."
        : `Could not load: ${error.message}`),
    h("button", { class: "btn btn-sm self-start", onclick: () => render() }, "Try again"),
  );
}

export { onThreadsView, routes, firstScreen, render };

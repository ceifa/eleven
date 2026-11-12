/* eleven dashboard — vanilla SPA, hand-written CSS, no build step.

   This is the entry point index.html loads, and the top of the module graph:
   it hands the router its views, listens for navigation, registers the service
   worker and boots the page. Everything else lives in the modules below it —

     state, api, ui, format, channels     what every module builds on
     chrome, router, modals, config       the frame around the views
     threads, thread-pane, thread-head,   the threads view
       composer, launcher, transcript,
       attachments, running, phone
     workspaces, models, usage, settings  the other views
     socket                               live updates from the daemon

   A module added here has to be named in three more places, or a cold start
   without the network (or an update) breaks: SHELL in sw.js, SHELL_FILES in
   ../shell-files.ts, and a modulepreload in index.html. */

import { browserBack } from "./nav-drag.js";
import { readSnapshot } from "./snapshot.js";
import { state } from "./state.js";
import { prefetch, seedCache, started } from "./api.js";
import { whenIdle } from "./ui.js";
import { initStringLights } from "./chrome.js";
import { render, routes } from "./router.js";
import { setPane, threadsLayout } from "./phone.js";
import { viewModels } from "./models.js";
import { viewWorkspaces } from "./workspaces.js";
import { viewUsage } from "./usage.js";
import { viewSettings } from "./settings.js";
import { openThread, rememberThread, restoreSeenThreads, seenKey } from "./thread-pane.js";
import { threadsQuery, viewThreads } from "./threads.js";
import { connectWs, refreshOverview } from "./socket.js";

// The router sits below the views it paints, so they are handed to it here.
Object.assign(routes, { threads: viewThreads, workspaces: viewWorkspaces, models: viewModels, providers: viewModels, usage: viewUsage, settings: viewSettings, channels: viewWorkspaces });

// A back the browser already slid (see browserBack) is shown as a cut: the
// screen it slid to is the one the page lands on.
const nativeBack = browserBack();

/**
 * A hash change is usually a route change — but not when it only moves between
 * the thread list and a conversation. Those are two halves of the threads view
 * that is already on screen (two *screens* on a phone), and re-rendering would
 * refetch the list and tear the pane down under whoever is reading it. This is
 * the path the back gesture takes, so it happens constantly on mobile.
 */
window.addEventListener("hashchange", (e) => {
  const layout = threadsLayout();
  const [route, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (!layout || (route || "threads") !== "threads") return render();
  setPane(Boolean(id), { animate: !nativeBack.animated(e) });
  if (id && id !== state.activeThread?.id) openThread(id);
});

// The other half of the back gesture: the launcher opens the pane without
// changing the hash (it has no thread to name yet), so backing out of it fires
// popstate alone. `pane` marks the entries this page pushed for that — landing
// on anything else means the pane is not what the reader is on anymore.
window.addEventListener("popstate", (e) => {
  nativeBack.popstate(e);
  if (!history.state?.pane) setPane(false, { animate: !nativeBack.animated(e) });
});

/* ---------- installable app ---------- */

// The worker is what makes eleven installable, and what answers a cold start
// with no network with something other than an error page. Registered after
// load so it never competes with the first paint; failures are silent, because
// a dashboard reached over plain http on a LAN address cannot have one and
// works perfectly well without it.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  // The worker answers the shell from its cache, so this page can be running
  // code the daemon has since replaced — it checks after every open and says so
  // when the bytes have moved. The fix is the socket's fix: reload, now that the
  // new bytes are the ones in the cache. Nothing is lost by it. Drafts are in
  // localStorage on every keystroke and everything else on screen is the
  // daemon's to send again.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "shell-updated") location.reload();
  });
}

/* ---------- boot ---------- */

/* The router asks for the first screen's reads one after another — the
   overview, then the thread list, then the conversation the address bar names —
   and each of those is a round trip to a daemon that, from a phone, is on the
   other side of a tunnel. None of them depends on the answer to another, and
   the address bar already says which they are, so they leave together and are
   waiting by the time the render walks into them. */
prefetch("/overview");
const [bootRoute, bootThread] = location.hash.replace(/^#\/?/, "").split("/");
if (!bootRoute || bootRoute === "threads") {
  prefetch(`/threads${threadsQuery()}`);
  if (bootThread) prefetch(`/threads/${bootThread}`);
}

/* And while those are in flight, what the page knew the last time it ran: the
   first frame is painted from it, and the reads above correct it as they land
   (snapshot.js). Waited on for a few milliseconds at most — it is local, and a
   store slower than the network is simply skipped. Only what the first frame
   shows is waited for: the overview, the list, and the one conversation the
   address bar names. The other transcripts the page had read are megabytes
   between them, and nothing on the first screen is drawn from those. */
const bootSeen = bootThread ? seenKey(bootThread) : undefined;
const restored = await readSnapshot(["overview", "threads", ...(bootSeen ? [bootSeen] : [])]);
if (restored.overview) seedCache("/overview", restored.overview);
if (restored.threads && !threadsQuery()) {
  state.threads = restored.threads;
  for (const thread of restored.threads) state.sources.add(thread.source);
}
const read = bootSeen ? restored[bootSeen]?.read : undefined;
if (read) rememberThread(read, { persist: false });

initStringLights();
connectWs();
// Paints the first screen from the reads above, pairing badge included. Then
// whatever is left unclaimed is dropped: a prefetch nobody wanted is an answer
// that only gets staler. A restored overview is not a read: the daemon's own
// answer is still in flight, and is taken before the drop.
render().finally(() => {
  if (restored.overview) refreshOverview();
  started.clear();
});
// The rest of what the page had read, for the taps that come after the first
// screen — brought back once the page has a moment to itself.
whenIdle(() => void restoreSeenThreads());

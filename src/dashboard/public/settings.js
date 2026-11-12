/* The Settings view, and the offer to install the dashboard as an app. */

import { state, view } from "./state.js";
import { cachedGet } from "./api.js";
import { h, labeled, pageTitle, sectionLabel } from "./ui.js";
import { render } from "./router.js";
import { queueSave } from "./config.js";

/* ---------- settings view ---------- */

async function viewSettings() {
  state.config = await cachedGet("/config");
  const c = state.config;

  const saveField = (mutate) => (e) =>
    queueSave((next) => { mutate(next, e.target.value.trim()); return next; });

  view.replaceChildren(
    pageTitle("Settings"),
    h("div", { class: "card bg-base-200 border max-w-3xl mb-4" },
      h("div", { class: "card-body gap-3" },
        sectionLabel("Dashboard"),
        h("div", { class: "grid-2 gap-4" },
          labeled("Host", h("input", { class: "input input-sm w-full font-mono", value: c.dashboard.host,
            onchange: saveField((n, v) => (n.dashboard.host = v)) }),
            "127.0.0.1 keeps the dashboard reachable only from this machine; 0.0.0.0 exposes it to the network."),
          labeled("Port", h("input", { class: "input input-sm w-full font-mono", type: "number", value: c.dashboard.port,
            onchange: saveField((n, v) => (n.dashboard.port = Number(v))) })),
        ),
        h("p", { class: "text-xs opacity-50" }, "Applies on the next daemon restart."),
      ),
    ),
    h("div", { class: "card bg-base-200 border max-w-3xl mb-4" },
      h("div", { class: "card-body gap-3" },
        sectionLabel("Sessions"),
        h("div", { class: "grid-2 gap-4" },
          labeled("Days idle before a new thread",
            h("input", { class: "input input-sm w-full font-mono", type: "number", min: "1", value: c.session?.idleDays ?? 7,
              onchange: saveField((n, v) => (n.session = { ...n.session, idleDays: Math.max(1, Number(v) || 7) })) }),
            "A conversation quiet for this many days starts a fresh thread — with clean context — on its next message."),
          labeled("Days to keep old threads",
            h("input", { class: "input input-sm w-full font-mono", type: "number", min: "1", value: c.session?.retentionDays ?? 30,
              onchange: saveField((n, v) => (n.session = { ...n.session, retentionDays: Math.max(1, Number(v) || 30) })) }),
            "Threads idle longer than this are deleted from disk, including their history and request logs."),
        ),
      ),
    ),
    installCard(),
    h("div", { class: "card bg-base-200 border max-w-3xl" },
      h("div", { class: "card-body gap-3" },
        sectionLabel("Voice transcription"),
        labeled("Command",
          h("textarea", { class: "textarea w-full font-mono text-xs", rows: "4", placeholder: "whisper-cli --model … {{file}}",
            onchange: saveField((n, v) => (n.transcription = v ? { command: v } : undefined)) },
            c.transcription?.command ?? ""),
          "Runs locally for each incoming voice note. {{file}} is the audio path; stdout becomes the message text. Leave empty to disable."),
      ),
    ),
  );
}

/**
 * Putting eleven on the home screen. Which of the three states you get is the
 * browser's decision, not ours: already installed, installable right now (the
 * only case where a button can do anything — see beforeinstallprompt), or a
 * browser that installs from its own menu and tells us nothing, which is every
 * one on iOS.
 */
function installCard() {
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const button = h("button", {
    class: "btn btn-sm btn-primary self-start",
    onclick: async (event) => {
      const prompt = installPrompt;
      if (!prompt) return;
      installPrompt = null; // a prompt is good for exactly one showing
      event.target.disabled = true;
      await prompt.prompt().catch(() => {});
    },
  }, "Install");
  return h("div", { class: "card bg-base-200 border max-w-3xl mb-4" },
    h("div", { class: "card-body gap-3" },
      sectionLabel("App"),
      !installed && installPrompt ? button : null,
      h("p", { class: "text-xs opacity-50" },
        installed
          ? "Running as an installed app."
          : installPrompt
            ? "Puts eleven in its own window, on the home screen or in the app list."
            : "This browser installs from its own menu — Share → Add to Home Screen on iOS, or the install icon in the address bar. It needs the dashboard on https or on localhost."),
      h("p", { class: "text-xs opacity-50" },
        "Installed or not, the interface itself is cached and opens without the network. The conversations in it still need the daemon."),
    ),
  );
}

// Chromium hands the install over exactly once, through this event, and only
// when it decides the page qualifies. Holding on to it is the only way to put
// the offer somewhere the user might look for it (Settings) rather than
// wherever the browser felt like putting its own.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  // Settings may already be on screen saying this browser installs from its own
  // menu — which just stopped being true.
  if (location.hash.startsWith("#/settings")) render();
});
window.addEventListener("appinstalled", () => { installPrompt = null; });

export { viewSettings };

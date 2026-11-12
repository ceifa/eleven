/* The chrome around the views: the wordmark that burns brighter while a turn
   streams, the string lights on the sidebar, and the pairing badge. */

import { state } from "./state.js";
import { flare } from "./ui.js";

// Both signs (sidebar + mobile top bar) glow together. They're static in the
// markup, so query once rather than re-scanning the DOM on every WS message.
const WORDMARKS = document.querySelectorAll(".wordmark");

let liveTimer;

/** The signature: the wordmark burns brighter while any turn is streaming. */
function pulse() {
  for (const wordmark of WORDMARKS) {
    // A turn just began (the sign was dark): stutter it to life before the steady glow.
    if (!wordmark.classList.contains("live")) flare(wordmark, "flicker");
    wordmark.classList.add("live");
  }
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => WORDMARKS.forEach((w) => w.classList.remove("live")), 2500);
}

/* ---------- string lights (the wall) ---------- */

// Bulb colors live in style.css (nth-of-type rules on --bulb) so a future
// theme block can repaint the wall; JS only does the geometry.
const BULB_COUNT = 8;
const bulbs = []; // the sockets: filled by initStringLights, then reused on every flash

const svgNode = (tag, attrs) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/**
 * Place the bulbs along the sidebar wire (index.html only ships the path).
 *
 * Each is a socket: the bulb, and under it the glow it throws when it flares.
 * The glow's gradient sits inside its own socket so its stops inherit that
 * socket's --bulb — the colour stays one rule in style.css, glow included.
 */
function initStringLights() {
  const svg = document.getElementById("string-lights");
  const wire = svg?.querySelector(".wire");
  const length = wire?.getTotalLength();
  if (!length) return;
  for (let i = 0; i < BULB_COUNT; i++) {
    const { x, y } = wire.getPointAtLength(((i + 0.5) / BULB_COUNT) * length);
    const socket = svgNode("g", { class: "socket" });
    socket.style.setProperty("--twinkle", `${i * -0.65}s`); // negative: start mid-phase
    const gradient = svgNode("radialGradient", { id: `bulb-glow-${i}` });
    gradient.append(
      svgNode("stop", { class: "bulb-glow-stop", offset: "0.3", "stop-opacity": "1" }),
      svgNode("stop", { class: "bulb-glow-stop", offset: "0.36", "stop-opacity": "0.5" }),
      svgNode("stop", { class: "bulb-glow-stop", offset: "1", "stop-opacity": "0" }),
    );
    socket.append(
      gradient,
      svgNode("circle", { class: "bulb-glow", cx: x, cy: y, r: "11", fill: `url(#bulb-glow-${i})` }),
      svgNode("circle", { class: "bulb", cx: x, cy: y, r: "2.6" }),
    );
    bulbs.push(socket);
    svg.append(socket);
  }
}

// Every live event flares the next bulb along the string, so a fast delta
// stream visibly chases light across the wire.
let bulbCursor = 0;
function stripFlash() {
  if (bulbs.length) flare(bulbs[bulbCursor++ % bulbs.length], "lit");
}

/** turn-error: every light on the wall flares red at once. */
function stripError() {
  for (const bulb of bulbs) {
    bulb.classList.remove("lit"); // the red sweep replaces any running flare
    flare(bulb, "err");
  }
}

/**
 * What the phone's chrome has to know about the threads view, said on the root
 * element where the chrome's rules can read it: `on-pane` while a pane is the
 * screen (the top bar goes, and the height it took), `on-conversation` while
 * that pane is not the launcher (the tab bar goes too). Both are read off the
 * two classes the threads view already keeps — `pane-open` on its layout,
 * `is-composing` on its pane — so whatever changes either of those, or takes
 * the layout off the page, calls this in the same breath: a layout measured
 * between the two would be measured against a bar that is no longer there.
 */
function syncPaneChrome() {
  const open = Boolean(document.getElementById("threads-layout")?.classList.contains("pane-open"));
  const composing = Boolean(document.getElementById("thread-pane")?.classList.contains("is-composing"));
  const root = document.documentElement.classList;
  root.toggle("on-pane", open);
  root.toggle("on-conversation", open && !composing);
}

// Paint the sidebar badge from whatever overview we already have in state.
function applyPairingBadge() {
  const badge = document.getElementById("pairing-badge");
  const count = state.overview?.pairing?.length ?? 0;
  badge.hidden = count === 0;
  badge.textContent = count;
  const tab = document.getElementById("tab-pairing-badge");
  tab.hidden = count === 0;
  tab.textContent = count;
}

export { pulse, initStringLights, stripFlash, stripError, syncPaneChrome, applyPairingBadge };

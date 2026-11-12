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
const bulbs = []; // filled by initStringLights, then reused on every flash

/** Place the bulbs along the sidebar wire (index.html only ships the path). */
function initStringLights() {
  const svg = document.getElementById("string-lights");
  const wire = svg?.querySelector(".wire");
  const length = wire?.getTotalLength();
  if (!length) return;
  for (let i = 0; i < BULB_COUNT; i++) {
    const point = wire.getPointAtLength(((i + 0.5) / BULB_COUNT) * length);
    const bulb = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bulb.setAttribute("cx", point.x);
    bulb.setAttribute("cy", point.y);
    bulb.setAttribute("r", "2.6");
    bulb.setAttribute("class", "bulb");
    bulb.style.setProperty("--twinkle", `${i * -0.65}s`); // negative: start mid-phase
    bulbs.push(bulb);
    svg.append(bulb);
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

export { pulse, initStringLights, stripFlash, stripError, applyPairingBadge };

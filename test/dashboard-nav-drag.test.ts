import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AXIS_SLOP, edgeZone, navDrag } from "../src/dashboard/public/nav-drag.js";

/* The drawer used to open one way: the hamburger, in the top-left corner. The
   swipe that replaced the stretch shares the screen with everything else a
   finger does there — scrolling the thread list, panning a code block, tapping
   a row — so most of what follows is about the gestures it must NOT take. */

const PUBLIC_DIR = join(import.meta.dirname, "..", "src", "dashboard", "public");
const DRAWER = 240;
const SCREEN = 390;

/** Play a whole gesture: land at the first point, move through the rest one
 *  frame (16ms) apart, let go. Returns what the drawer was told to do. */
function swipe(points: [number, number][], { open = false } = {}) {
  const drag = navDrag();
  const [[x, y]] = points;
  drag.start({ x, y, at: 0, open, drawer: DRAWER, screen: SCREEN });
  const seen: number[] = [];
  for (const [px, py] of points.slice(1)) {
    const at = drag.move({ x: px, y: py, at: seen.length * 16 + 16 });
    if (at) seen.push(at.progress);
  }
  return { end: drag.end(), progress: seen };
}

test("a swipe in from the left edge pulls the drawer open", () => {
  const { end, progress } = swipe([[10, 400], [40, 400], [120, 402], [220, 405]]);
  assert.deepEqual(end, { open: true });
  // And it tracked the finger on the way — the point of dragging rather than
  // waiting for the release to animate.
  assert.ok(progress.length >= 2, "the drawer should have followed the finger");
  assert.ok(progress[0] < progress.at(-1)!);
  assert.equal(progress.at(-1), 210 / DRAWER);
});

test("a touch that starts past the edge zone is not reaching for the drawer", () => {
  const drag = navDrag();
  const inside = drag.start({ x: edgeZone(SCREEN) + 1, y: 400, at: 0, open: false, drawer: DRAWER, screen: SCREEN });
  assert.equal(inside, false);
  // …and it stays out of the way however far it then travels.
  assert.equal(drag.move({ x: 300, y: 400, at: 16 }), null);
  assert.equal(drag.end(), null);
});

test("the edge zone is wider than the strip the OS claims", () => {
  // iOS and Android both read a swipe from the outermost few millimetres as
  // "go back", so a zone that only lived there would be a gesture the phone
  // wins first. ~20px is the widest system zone in play; the drawer's has to
  // reach well past it on a phone and not run away on a tablet.
  assert.ok(edgeZone(390) > 40, "a phone's edge zone should clear the system's");
  assert.ok(edgeZone(390) < 390 / 3, "…without owning a third of the screen");
  assert.equal(edgeZone(120), 32, "a narrow screen still gets a thumb's worth");
});

test("scrolling the page is not a drawer drag", () => {
  // The list under the finger scrolls vertically, and the edge zone covers a
  // fifth of it. A drawer that grabbed this would make the whole screen feel
  // stuck.
  const { end, progress } = swipe([[10, 400], [12, 360], [14, 300], [16, 220]]);
  assert.equal(end, null);
  assert.deepEqual(progress, []);
});

test("a swipe the way the drawer can't go is somebody else's gesture", () => {
  assert.equal(swipe([[10, 400], [4, 400], [0, 400]]).end, null); // closed, leftward
  assert.equal(swipe([[120, 400], [200, 400], [300, 400]], { open: true }).end, null); // open, rightward
});

test("a tap keeps working", () => {
  // Everything in the left fifth of the screen is a link or a row before it is
  // an edge: nothing may come out of a touch that doesn't travel.
  assert.equal(swipe([[10, 400], [11, 401], [10, 400]]).end, null);
  assert.equal(swipe([[10, 400], [10 + AXIS_SLOP, 400]]).end, null, "slop is not travel");
});

test("a finger that stops moving hands the decision to the position", () => {
  // Pulled out fast, then parked for a few frames: 90px of a 240px drawer.
  // Peeking and thinking better of it puts it back…
  const held = (x: number): [number, number][] => [[x, 400], [x, 400], [x, 400], [x, 400]];
  assert.deepEqual(swipe([[10, 400], [50, 400], [80, 400], [88, 400], ...held(90)]).end, { open: false });
  // …and the same gesture past halfway leaves it out. Neither reading may come
  // from how fast the finger got there, which was quick in both.
  assert.deepEqual(swipe([[10, 400], [80, 400], [140, 400], [148, 400], ...held(150)]).end, { open: true });
});

test("a flick opens the drawer from wherever it got to", () => {
  const drag = navDrag();
  drag.start({ x: 10, y: 400, at: 0, open: false, drawer: DRAWER, screen: SCREEN });
  drag.move({ x: 30, y: 400, at: 8 });
  drag.move({ x: 70, y: 400, at: 16 }); // 60px in 16ms — nearly 4px/ms
  // A quarter of the way out, released still travelling: the finger has said
  // what it wants, and dropping the drawer back because 70px is where it left
  // the glass is the drawer arguing with it.
  assert.deepEqual(drag.end(), { open: true });
});

test("swiping the open drawer back closes it", () => {
  const { end, progress } = swipe([[200, 400], [160, 400], [90, 400], [40, 400]], { open: true });
  assert.deepEqual(end, { open: false });
  assert.equal(progress[0], (DRAWER - 40) / DRAWER, "it should start from open, not from shut");
  assert.ok(progress.at(-1)! < progress[0]);
});

test("a drawer with no width can't be dragged", () => {
  // Desktop, or a shell that hasn't laid out yet. Nothing to follow the finger
  // with, and a division by zero if we tried.
  const drag = navDrag();
  assert.equal(drag.start({ x: 5, y: 400, at: 0, open: false, drawer: 0, screen: SCREEN }), false);
  assert.equal(drag.move({ x: 200, y: 400, at: 16 }), null);
});

test("the page and the drawer agree on how a drag is painted", () => {
  const css = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));

  // The gesture only moves anything through this variable, and only while the
  // class that kills the transition is on — otherwise the drawer chases the
  // finger a quarter-second behind it.
  assert.match(mobile, /body\.nav-dragging #sidebar \{[^}]*transform: translateX\(calc\(-100% \+ var\(--nav-progress, 0\) \* 100%\)\);[^}]*transition: none;/);
  assert.match(mobile, /body\.nav-dragging \.nav-backdrop \{ opacity: var\(--nav-progress, 0\);/);
  assert.match(app, /setProperty\("--nav-progress"/);
  assert.match(app, /classList\.add\("nav-dragging"\)/);

  // Same specificity as the .nav-open rules, so the drag ones only win by
  // sitting after them.
  assert.ok(mobile.indexOf("body.nav-dragging #sidebar") > mobile.indexOf("body.nav-open #sidebar"));
  assert.ok(mobile.indexOf("body.nav-dragging .nav-backdrop") > mobile.indexOf("body.nav-open .nav-backdrop"));

  // preventDefault is ignored on a passive listener, and without it the page
  // scrolls under a drawer that is supposed to be following the finger.
  assert.match(app, /"touchmove",[\s\S]*?\{ passive: false \}\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { AXIS_SLOP, browserBack, edgeZone, navDrag } from "../src/dashboard/public/nav-drag.js";

/* The edge swipe was written for the navigation drawer and now drives the
   swipe back out of a conversation (the module still speaks the drawer's
   words: the list is what comes out from the left, and "open" is back). It
   shares the screen with everything else a finger does there — scrolling the
   transcript, panning a code block, tapping a link — so most of what follows
   is about the gestures it must NOT take. */

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

test("the page and the gesture agree on how a swipe back is painted", () => {
  const css = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));

  // The gesture only moves anything through this variable, and only while the
  // class that holds it is on — the pane off to the right by exactly the share
  // of the screen the finger has travelled, the list coming in under it.
  assert.match(mobile, /body\.swiping-back #thread-pane \{[^}]*transform: translateX\(calc\(var\(--back\) \* 100%\)\);/);
  assert.match(mobile, /body\.swiping-back \.threads-layout\.pane-open \.threads-list-col \{[^}]*display: flex;/);
  assert.match(app, /setProperty\("--back"/);
  assert.match(app, /classList\.add\("swiping-back"\)/);
  // Only a conversation can be swiped out of: on the list there is nowhere back
  // to go, and the gesture must leave the page's own touches alone.
  assert.match(app, /if \(!isPhone\(\) \|\| !open \|\|/);

  // preventDefault is ignored on a passive listener, and without it the
  // transcript scrolls under a pane that is supposed to be following the finger.
  assert.match(app, /"touchmove",[\s\S]*?\{ passive: false \}\)/);
});

/** Run the page's touch listeners without booting its API and WebSocket. */
function pageSwipe() {
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const source = app.slice(app.indexOf("const swipe = navDrag();"), app.indexOf("/* ---------- the phone's viewport"));
  const listeners = new Map<string, (event: any) => void>();
  const timers: (() => void)[] = [];
  const classes = new Set<string>();
  const styles = new Map<string, string>();
  let open = true;
  let backs = 0;
  const body = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
    },
    style: {
      setProperty: (key: string, value: string) => styles.set(key, value),
      removeProperty: (key: string) => styles.delete(key),
    },
  };
  vm.runInNewContext(source, {
    navDrag,
    isPhone: () => true,
    window: { innerWidth: SCREEN },
    document: {
      body,
      querySelector: () => null,
      getElementById: () => ({ addEventListener() {} }),
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    },
    threadsLayout: () => ({ classList: { contains: () => open, remove: () => { open = false; } } }),
    history: { state: { pane: true }, back: () => { backs++; } },
    setTimeout: (callback: () => void) => timers.push(callback),
  });
  let at = 0;
  return {
    classes,
    styles,
    timers,
    get backs() { return backs; },
    get open() { return open; },
    touch(type: string, x: number, { cancelable = true } = {}) {
      const event = {
        touches: [{ clientX: x, clientY: 400 }],
        target: body,
        timeStamp: at += 16,
        cancelable,
        defaultPrevented: false,
        preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
      };
      listeners.get(type)!(event);
      return event;
    },
  };
}

test("the page leaves the system's outermost edge to native back", () => {
  for (const x of [0, 10, 20]) {
    const page = pageSwipe();
    page.touch("touchstart", x);
    assert.equal(page.touch("touchmove", 240).defaultPrevented, false);
    page.touch("touchend", 240);
    assert.equal(page.classes.has("swiping-back"), false, `native edge x=${x} must not paint a second list`);
    assert.equal(page.timers.length, 0);
    assert.equal(page.backs, 0);
  }
});

test("a page-owned swipe still follows the finger and goes back once", () => {
  const page = pageSwipe();
  page.touch("touchstart", 40);
  const move = page.touch("touchmove", 240);
  assert.equal(move.defaultPrevented, true);
  assert.equal(page.classes.has("swiping-back"), true);
  assert.equal(page.styles.get("--back"), String(200 / SCREEN));
  page.touch("touchend", 240);
  assert.equal(page.classes.has("swipe-settling"), true);
  page.timers.forEach((finish) => finish());
  assert.equal(page.open, false);
  assert.equal(page.backs, 1);
  assert.equal(page.classes.size, 0);
  assert.equal(page.styles.size, 0);
});

test("a non-cancelable move belongs to the browser, not the page", () => {
  const page = pageSwipe();
  page.touch("touchstart", 40);
  page.touch("touchmove", 180, { cancelable: false });
  // Once ownership is lost, a later event must not revive the page's drag.
  page.touch("touchmove", 240);
  page.touch("touchend", 240);
  assert.equal(page.classes.size, 0);
  assert.equal(page.styles.size, 0);
  assert.equal(page.timers.length, 0);
  assert.equal(page.backs, 0);
});

for (const interruption of ["touchcancel", "non-cancelable move"]) {
  test(`${interruption} removes the page's partial swipe immediately`, () => {
    const page = pageSwipe();
    page.touch("touchstart", 40);
    page.touch("touchmove", 140);
    assert.equal(page.classes.has("swiping-back"), true);
    if (interruption === "touchcancel") page.touch("touchcancel", 140);
    else page.touch("touchmove", 240, { cancelable: false });
    assert.equal(page.classes.size, 0, "native navigation must not capture a settling page swipe");
    assert.equal(page.styles.size, 0);
    page.touch("touchend", 240);
    assert.equal(page.timers.length, 0);
    assert.equal(page.backs, 0);
    assert.equal(page.open, true);
  });
}

test("a back the browser already slid is not slid again by the page", () => {
  // Regression: Safari's edge swipe animated the way back to the list, then
  // the popstate and hashchange it fires slid the page back a second time.
  const back = browserBack();
  back.popstate({ hasUAVisualTransition: true, timeStamp: 1_000 });
  assert.equal(back.animated({ timeStamp: 1_000 }), true); // popstate itself
  assert.equal(back.animated({ timeStamp: 1_040 }), true); // its hashchange

  // The ‹ button and the in-page swipe go back through history too, with no
  // animation from the browser: the page does the sliding.
  back.popstate({ hasUAVisualTransition: false, timeStamp: 5_000 });
  assert.equal(back.animated({ timeStamp: 5_020 }), false);

  // Nor does a later hashchange — a tap on a thread — inherit an old answer.
  back.popstate({ hasUAVisualTransition: true, timeStamp: 9_000 });
  assert.equal(back.animated({ timeStamp: 15_000 }), false);
  // A browser that never says has never animated anything.
  const plain = browserBack();
  plain.popstate({ timeStamp: 100 });
  assert.equal(plain.animated({ timeStamp: 120 }), false);
});

test("the page hands the browser's answer to both halves of a traversal", () => {
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const popstate = app.slice(app.indexOf('window.addEventListener("popstate"'));
  assert.match(popstate.slice(0, 200), /nativeBack\.popstate\(e\);\s*if \(!history\.state\?\.pane\) setPane\(false, \{ animate: !nativeBack\.animated\(e\) \}\)/);
  const hashchange = app.slice(app.indexOf('window.addEventListener("hashchange"'));
  assert.match(hashchange.slice(0, 400), /setPane\(Boolean\(id\), \{ animate: !nativeBack\.animated\(e\) \}\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/* The dashboard felt slow on a machine that was not: the daemon answered in
   milliseconds and the page spent its time on itself. None of what follows is
   visible in a diff as a bug — the page looks the same either way — so each of
   these says what the cost was, and holds the line on the thing that removed it.

   The app is modules that boot against a live daemon, so what is checked here
   is their source and the stylesheet's. */

const PUBLIC_DIR = join(import.meta.dirname, "..", "src", "dashboard", "public");
const read = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");
/** The stylesheet without its comments, which quote the rules they replaced. */
const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The properties a @keyframes block animates. */
function animated(name: string) {
  const at = css.indexOf(`@keyframes ${name} {`);
  assert.ok(at >= 0, `@keyframes ${name} should still exist`);
  let depth = 0;
  let end = at;
  for (let index = css.indexOf("{", at); index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}" && --depth === 0) { end = index; break; }
  }
  const body = css.slice(css.indexOf("{", at) + 1, end);
  const properties = new Set<string>();
  for (const step of body.matchAll(/\{([^}]*)\}/g)) {
    for (const declaration of step[1].split(";")) {
      const property = declaration.split(":")[0].trim();
      if (property) properties.add(property);
    }
  }
  return [...properties].sort();
}

test("what animates for as long as a turn runs is the compositor's work", () => {
  // A thread working puts a breathing halo on its card, a glow on the sign and
  // a flare on a bulb for every event — for minutes at a time, and with a few
  // agents running, always. Animated as box-shadow, text-shadow and a
  // drop-shadow filter, each of those repainted the page on the main thread
  // every frame: a third of it gone on a dashboard nobody was touching, and
  // more than half while a reply streamed. Opacity and transform are animated
  // off the main thread; nothing that runs indefinitely may animate more.
  const compositor = new Set(["opacity", "transform"]);
  for (const name of ["e11-live", "e11-glow", "e11-bulb", "e11-bulb-glow", "e11-twinkle", "e11-sweep", "e11-spin", "e11-breathe"]) {
    const extra = animated(name).filter((property) => !compositor.has(property));
    assert.deepEqual(extra, [], `@keyframes ${name} repaints every frame it runs: it animates ${extra.join(", ")}`);
  }
  // The halo, the glow and the sweep are worn by a layer of their own, so the
  // element they decorate is never the thing being animated.
  assert.match(css, /button\.card\.is-live::after, \.card\.is-live \.thread-avatar::before \{[^}]*box-shadow:[^}]*animation: e11-live/);
  assert.match(css, /\.wordmark\.live::after \{ animation: e11-glow/);
  assert.match(css, /body\.is-loading \.route-progress::before \{ animation: e11-sweep/);
  // An SVG transform is laid out on the main thread; a bulb only fades.
  assert.deepEqual(animated("e11-bulb"), ["opacity"]);
});

test("a flare replayed mid-flight does not lay the page out to do it", () => {
  // Every event of a streaming turn flares a bulb, and the one it lands on is
  // usually still fading from the last time. Dropping the class and reading a
  // rect to make the browser notice restarts it — and is a forced layout of
  // the page per event.
  const flare = read("ui.js").match(/function flare\(el, cls\) \{([\s\S]*?)\n\}/);
  assert.ok(flare, "ui.js should still have flare()");
  assert.doesNotMatch(flare[1], /getBoundingClientRect|offsetWidth|offsetHeight/);
  assert.match(flare[1], /getAnimations\(\{ subtree: true \}\)\) animation\.currentTime = 0;/);
});

test("a read of the open thread that changed nothing touches nothing", () => {
  const transcript = read("transcript.js");
  const pane = read("thread-pane.js");
  // The thread on screen is read again after every turn, every message, and
  // once more to correct a pane painted from memory. Each read used to rebuild
  // every row: the markdown parsed again, the pictures fetched again, the whole
  // column laid out again. A row is now kept under what it was drawn from…
  const rows = transcript.match(/function durableRows\([^)]*\) \{([\s\S]*?)\n\}/);
  assert.ok(rows, "transcript.js should still have durableRows()");
  assert.match(rows[1], /drawn\.get\(signature\)\?\.shift\(\) \?\? transcriptNode\(row\)/);
  // …and the rows are reconciled into the transcript, not swapped for it.
  const render = pane.match(/function renderThreadPane\(\) \{([\s\S]*?)\n\}/);
  assert.ok(render, "thread-pane.js should still have renderThreadPane()");
  assert.match(render[1], /syncChildren\(transcript, durableRows\(\)\)/);
  assert.doesNotMatch(render[1], /getElementById\("transcript"\)\?\.replaceChildren/);

  // What a row shows has to be in what it is kept under, or a stale node is
  // "the same row": a press spends a block of buttons, and the diagnostics
  // toggle changes how a message is drawn.
  const signature = transcript.match(/function rowSignature\(row\) \{([\s\S]*?)\n\}/);
  assert.ok(signature, "transcript.js should still have rowSignature()");
  assert.match(signature[1], /pressedButtons\.get\(row\.call\.id\)/);
  assert.match(signature[1], /state\.showRequests/);
  assert.match(signature[1], /row\.grouped/);
});

test("a conversation opens on its end, and the rest arrives without moving it", () => {
  const transcript = read("transcript.js");
  // Opening draws the last rows; the ones above them are filled in while the
  // page is idle, so a long conversation does not hold the tap for its length.
  assert.match(read("thread-pane.js"), /h\("div", \{ id: "transcript" \}, durableRows\(\{ opening: true \}\)\)/);
  const fill = transcript.match(/function fillOlderRows\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fill, "transcript.js should still have fillOlderRows()");
  assert.match(fill[1], /whenIdle\(/);
  // Rows arriving above the reader keep them where they were: pinned to the
  // bottom if they were there, on the same row if they were not — by hand
  // where the browser does not anchor the scroll itself.
  assert.match(fill[1], /if \(pinned\) el\.scrollTop = el\.scrollHeight;/);
  assert.match(fill[1], /else if \(el\.scrollTop === top\) el\.scrollTop = top \+ \(el\.scrollHeight - height\);/);
  // …and old rows drawn late are not counted as new messages on the pill.
  assert.match(fill[1], /messagesWhenAway \+= messageCount\(\) - messages;/);
});

test("a streamed reply puts on the page what the delta changed", () => {
  // Parsed from the top on every delta — and until now handed to the page
  // whole each time, three hundred fresh elements to style and lay out for a
  // sentence that grew by five words.
  const live = read("transcript.js").match(/function renderLive\([^)]*\) \{([\s\S]*?)\n\}/);
  assert.ok(live, "transcript.js should still have renderLive()");
  assert.match(live[1], /streamed\.innerHTML = md\(last\.text\);\s*replaceTail\(body, \[\.\.\.streamed\.content\.childNodes\]\);/);
  assert.doesNotMatch(live[1], /body\.innerHTML =/);
});

test("the rows of a list are skipped while they are off screen, and built a screenful at a time", () => {
  // Hundreds of cards, a dozen in view. The rest are not laid out or painted
  // until they scroll near. A skipped card has nothing inside to hold it open,
  // and in a flex column that overflows it would be squeezed to no height at
  // all — so it must not shrink…
  assert.match(css, /#thread-list > \.card \{ content-visibility: auto; contain-intrinsic-size: auto [\d.]+rem; flex-shrink: 0; \}/);
  // …except a live one, whose halo sits outside the box that containment clips to.
  assert.match(css, /#thread-list > button\.card\.is-live \{ content-visibility: visible; \}/);
  // A call is always one line, so the height a skipped row is assumed to have
  // is the height it has, and the scrollbar stays exact.
  assert.match(css, /\.tool-calls-list > \.tool-call \{ content-visibility: auto; contain-intrinsic-size: auto 1\.1625rem; \}/);
  assert.match(css, /\.tool-call \{[^}]*font-size: 0\.75rem; line-height: 1\.55;/, "1.1625rem is one line of a call: 0.75rem at 1.55");

  // And the first time a card is drawn it is drawn whole, so the list is not
  // built in one go: the first rows now, the rest while the page is idle.
  const list = read("threads.js").match(/function renderThreadList\(\) \{([\s\S]*?)\n\}/);
  assert.ok(list, "threads.js should still have renderThreadList()");
  assert.match(list[1], /if \(rows\.length >= listRows\) \{\s*more = true;\s*break;\s*\}/);
  assert.match(list[1], /if \(more\) growThreadList\(\);/);
});

test("the list under an open conversation is out of sight, not out of the page", () => {
  // On a phone the list and a conversation are two screens. Hiding the list
  // with display:none threw its layout away, and every back — the move made
  // here more than any other — styled and laid out every row again.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  const hidden = mobile.match(/\n  \.threads-layout\.pane-open \.threads-list-col \{([^}]*)\}/);
  assert.ok(hidden, "the mobile block should still say what the list does under an open pane");
  assert.match(hidden[1], /visibility: hidden;/);
  assert.match(hidden[1], /position: absolute;/);
  assert.doesNotMatch(hidden[1], /display: none/);
  // It waits in the box the swipe back shows it in, so the drag starts on a
  // list that is already laid out where it is drawn.
  const swiping = mobile.match(/body\.swiping-back \.threads-layout\.pane-open \.threads-list-col \{([^}]*)\}/);
  assert.ok(swiping);
  assert.match(swiping[1], /visibility: visible;/);
  assert.doesNotMatch(swiping[1], /padding|inset/, "the swipe must not move the list it reveals");
});

test("remembering one conversation writes one conversation", () => {
  // The transcripts read lately are kept on the device for the next cold
  // start. All under one key, each read of any thread copied every one of them
  // into the store, and each start copied them all back out before its first
  // frame — megabytes, on the main thread, both ways.
  const pane = read("thread-pane.js");
  assert.match(pane, /const seenKey = \(id\) => `\$\{SEEN_PREFIX\}\$\{id\}`;/);
  assert.doesNotMatch(pane, /keep\("seen", \[/);
  // A thread that falls out of memory leaves the device too.
  const trim = pane.match(/function trimSeen\(\) \{([\s\S]*?)\n\}/);
  assert.ok(trim);
  assert.match(trim[1], /keep\(seenKey\(oldest\), undefined\);/);
  assert.match(pane, /function forgetThread\(id\) \{\s*if \(seenThreads\.delete\(id\)\) keep\(seenKey\(id\), undefined\);/);
});

test("a view already shown is painted from what it showed", () => {
  // The usage report walks every session file the daemon has; a window this
  // page has drawn before is drawn again at once, and corrected when the read
  // lands — only if a number moved, and only if the page is still the one on
  // screen.
  const usage = read("usage.js").match(/async function viewUsage\(\) \{([\s\S]*?)\n\}/);
  assert.ok(usage, "usage.js should still have viewUsage()");
  assert.match(usage[1], /const held = reports\.get\(asked\);\s*if \(held && state\.config\) \{\s*paintUsage\(held, days, metric\);/);
  assert.match(usage[1], /if \(showing && JSON\.stringify\(report\) !== JSON\.stringify\(held\)\) paintUsage\(report, days, metric\);/);
});

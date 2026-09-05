import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/* The installable half of the dashboard is a set of files that only work if
   they agree with each other, and nothing at runtime checks that they do: a
   precached path that no longer exists just fails to cache, an icon the
   manifest names and the repo doesn't just doesn't appear on the home screen.
   Nobody notices until the phone is offline or the icon is a grey square. */

const PUBLIC_DIR = join(import.meta.dirname, "..", "src", "dashboard", "public");
const read = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");

/** Width and height out of a PNG's IHDR, which is always its first chunk. */
function pngSize(name: string) {
  const bytes = readFileSync(join(PUBLIC_DIR, name));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG", `${name} should be a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("every icon the manifest names exists, at the size it claims", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];

  for (const icon of icons) {
    assert.ok(icon.src.startsWith("/"), `${icon.src} should be an absolute path`);
    const file = icon.src.slice(1);
    assert.ok(existsSync(join(PUBLIC_DIR, file)), `${icon.src} is in the manifest but not in public/`);
    if (icon.sizes === "any") continue; // the SVG, which has no pixels to check
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(file), { width, height }, `${icon.src} is not ${icon.sizes}`);
  }

  // Android crops a maskable icon to whatever shape the launcher likes; without
  // one of its own it crops the plain icon instead, and the wire of bulbs under
  // the letter comes out sliced in half.
  assert.ok(icons.some((icon) => icon.purpose === "maskable"), "the manifest needs a maskable icon");
  assert.ok(icons.some((icon) => icon.purpose === "any" && icon.type === "image/png"));

  // Safari ignores the manifest for the home screen and reads this instead.
  const shell = read("index.html");
  const apple = shell.match(/rel="apple-touch-icon" href="([^"]+)"/);
  assert.ok(apple, "index.html should link an apple-touch-icon");
  assert.ok(existsSync(join(PUBLIC_DIR, apple[1].slice(1))), `${apple[1]} is linked but missing`);

  // start_url has to land somewhere the router understands, or the installed
  // app opens on a blank view.
  assert.match(manifest.start_url, /^\/#\//);
});

test("the worker precaches files that are actually there", () => {
  const worker = read("sw.js");
  const list = worker.match(/const SHELL = \[([^\]]+)\]/);
  assert.ok(list, "sw.js should still declare a SHELL list");
  const paths = [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(paths.length > 5, "the shell list looks truncated");

  for (const path of paths) {
    if (path === "/") continue; // the SPA fallback, served as index.html
    assert.ok(existsSync(join(PUBLIC_DIR, path.slice(1))), `sw.js precaches ${path}, which does not exist`);
  }
  // Everything the shell imports has to be in there, or a cold offline start
  // paints the page and then dies on a missing module.
  for (const module of ["/app.js", "/dom.js", "/live-turn.js", "/markdown.js", "/message-display.js", "/waveform.js", "/style.css", "/index.html"]) {
    assert.ok(paths.includes(module), `${module} is part of the shell and is not precached`);
  }
});

test("the worker leaves the daemon's live surfaces alone", () => {
  const worker = read("sw.js");
  // A cached /api read is a lie about what the agent is doing right now, and
  // /media holds private attachments. Both must reach the network or nothing.
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /request\.method !== "GET"/);
  // Network-first, not cache-first: the daemon serves this app off the checkout
  // and the page reloads itself when the shell version moves. A cache-first
  // shell would answer that very reload with the bytes it is leaving behind.
  assert.match(worker, /async function networkFirst/);
  assert.doesNotMatch(worker, /caches\.match\(request\)\s*\|\|\s*fetch/);
});

test("the shell asks for the app frame a phone needs", () => {
  const shell = read("index.html");
  assert.match(shell, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(shell, /<script type="module" src="\/app\.js">/);
  // viewport-fit=cover is what puts the page under the notch — and what makes
  // every env(safe-area-inset-*) in style.css mean anything.
  assert.match(shell, /name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(shell, /name="theme-color" content="#0e0707"/);
  assert.match(shell, /name="apple-mobile-web-app-capable" content="yes"/);
});

test("the phone layout subtracts the chrome it actually has", () => {
  const css = read("style.css");
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");

  // The threads screen is sized by subtraction, so every term has to be there:
  // the top bar (notch included), the home indicator, and the keyboard.
  const layout = css.match(/@media \(max-width: 768px\)[\s\S]*?\.threads-layout \{([\s\S]*?)\}/);
  assert.ok(layout, "the mobile block should still size .threads-layout");
  for (const term of ["100dvh", "var(--topbar)", "var(--safe-b)", "var(--keyboard, 0px)"]) {
    assert.ok(layout[1].includes(term), `.threads-layout must account for ${term}`);
  }

  // …and --keyboard only ever holds a number if app.js measures it. iOS slides
  // the keyboard over the page instead of resizing it, so dvh keeps reporting
  // the whole screen while the composer sits behind the keys.
  assert.match(app, /visualViewport/);
  assert.match(app, /setProperty\("--keyboard"/);
});

/** Split a CSS shorthand into its sides, keeping calc(…) whole. */
function sides(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

test("an open conversation cancels the view's padding exactly", () => {
  const css = read("style.css");
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));

  // The conversation runs edge to edge on a phone: no card, no gutter. It gets
  // there with negative margins, which only works while they are the view's own
  // padding with the sign flipped — widen #view's gutter and forget these, and
  // the pane hangs off the side of the screen with a scrollbar under it.
  const padding = mobile.match(/#view \{\s*padding: ([^;]+);/);
  const margin = mobile.match(/\.threads-layout\.pane-open \{\s*margin: ([^;]+);/);
  assert.ok(padding && margin, "the mobile block should set both #view's padding and the open pane's margin");

  const [, right, bottom, left] = sides(padding[1]);
  const [, marginRight, marginBottom, marginLeft] = sides(margin[1]);
  // Not the top: the bar up there is fixed, so the pane has to keep clearing it
  // — only the gap under it is cancelled.
  const negated = (value: string) => value.replace("calc(", "calc(-").replace(" + ", " - ");
  assert.equal(marginRight, negated(right));
  assert.equal(marginBottom, negated(bottom));
  assert.equal(marginLeft, negated(left));

  // And with the pane reaching the bottom edge, the room the home indicator
  // needs stops being the view's to leave and becomes the composer's.
  assert.match(mobile, /\.threads-layout\.pane-open \.composer \{ padding-bottom: calc\([^)]*var\(--safe-b\)\); \}/);
});

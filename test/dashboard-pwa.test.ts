import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  // Everything the shell is made of has to be in there, or a cold offline start
  // paints the page and then dies on a missing module. Read off the directory
  // rather than listed here: the failure this catches is somebody adding a
  // module and forgetting the worker, and a hand-written list has the same bug.
  const modules = readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith(".js") && name !== "sw.js") // the worker isn't cached by itself
    .map((name) => `/${name}`);
  for (const module of [...modules, "/style.css", "/index.html"]) {
    assert.ok(paths.includes(module), `${module} is part of the shell and is not precached`);
  }
  // And the daemon has to know about them too: SHELL_FILES is what the shell
  // version is stamped from, so a module missing from it is one whose edits
  // never tell an open page to reload.
  const server = readFileSync(join(import.meta.dirname, "..", "src", "dashboard", "server.ts"), "utf8");
  const served = server.match(/const SHELL_FILES = \[([\s\S]*?)\n\];/);
  assert.ok(served, "server.ts should still declare SHELL_FILES");
  for (const module of modules) {
    assert.ok(served[1].includes(`"${module.slice(1)}"`), `${module} is part of the shell and server.ts doesn't list it`);
  }
});

test("the worker leaves the daemon's live surfaces alone", () => {
  const worker = read("sw.js");
  // A cached /api read is a lie about what the agent is doing right now, and
  // /media holds private attachments. Both must reach the network or nothing.
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /request\.method !== "GET"/);
  assert.match(worker, /async function networkFirst/);
});

test("the shell is answered from the cache, and a stale one is corrected after", () => {
  const worker = read("sw.js");

  // The point of the worker on a phone: a navigation is painted from the cache
  // instead of waiting out a tunnel. Going to the network first put the page,
  // its stylesheet, its modules and the first API read in a single queue in
  // front of the first pixel.
  const navigate = worker.match(/request\.mode === "navigate"\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(navigate, "the worker should still special-case navigations");
  assert.match(navigate[1], /respondWith\(cacheFirst\(request, "\/index\.html"\)\)/);
  assert.match(worker, /CACHED_PATHS\.has\(url\.pathname\)[\s\S]{0,80}cacheFirst\(request\)/);

  // …which is only safe because the freshness that network-first bought is
  // bought again right after: the daemon serves this app off a checkout, so a
  // cached page can be older than the API it is about to call. Every shell
  // entry is held against the daemon on open, and a page running bytes that
  // have moved is told to reload into the new ones.
  assert.match(navigate[1], /waitUntil\(revalidateShell\(\)\)/);
  const revalidate = worker.match(/function revalidateShell\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(revalidate, "the worker should still revalidate the shell");
  assert.match(revalidate[1], /SHELL\.map/); // all of it, not just the html
  assert.match(revalidate[1], /store\(cache, path, response\)/);
  assert.match(revalidate[1], /postMessage\(\{ type: "shell-updated" \}\)/);
  // A file the worker never had is not a change — flagging it would reload the
  // page once for every asset added to the list since it was installed.
  assert.match(revalidate[1], /previous && version\(previous\) !== version\(response\)/);

  // Everything that fills the cache goes through the one writer, which drops
  // the headers describing a compression the stored body no longer has. The
  // daemon serves brotli; a worker's fetch decodes it and leaves
  // `content-encoding: br` and the compressed length behind in the headers.
  // Chromium ignores them when it replays the entry, and a browser that didn't
  // would fail to open the app from the cache at all.
  assert.match(worker, /async function store\(cache, key, response\)/);
  assert.match(worker, /headers\.delete\("content-encoding"\)/);
  assert.match(worker, /headers\.delete\("content-length"\)/);
  // …including the install, which used to hand the job to cache.add().
  assert.doesNotMatch(worker, /caches?\.add\(/);
  assert.match(worker, /store\(cache, path, response\)/);
  // One writer, and it is store(): any other cache.put() is a path that skipped
  // the headers being dropped.
  assert.equal([...worker.matchAll(/\.put\(/g)].length, 1, "the cache should only ever be written through store()");

  // And the page has to act on it, or the worker is talking to itself.
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const listener = app.match(/serviceWorker\.addEventListener\("message",([\s\S]*?)\n {2}\}\);/);
  assert.ok(listener, "app.js should listen for the worker's messages");
  assert.match(listener[1], /"shell-updated"/);
  assert.match(listener[1], /location\.reload\(\)/);
});

test("the first screen's reads leave together", () => {
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");

  // With the shell cached, what is left of a cold start is the API — and the
  // router walks into those reads one at a time: /overview, then the list, then
  // the conversation the hash names. Three round trips through a tunnel, none
  // of which needs the one before it. The boot starts them all at once and
  // api.get takes whatever is already in flight for the path it is asked for.
  assert.match(app, /get: \(path\) => take\(path\) \?\? fetch\(`\/api\$\{path\}`\)/);
  assert.match(app, /prefetch\("\/overview"\)/);
  assert.match(app, /prefetch\(`\/threads\$\{threadsQuery\(\)\}`\)/);
  assert.match(app, /prefetch\(`\/threads\/\$\{bootThread\}`\)/);

  // A prefetch is only ever taken once, and only by the boot render — an answer
  // nobody claimed is dropped rather than kept around to be served stale later.
  const take = app.match(/function take\(path\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(take, "app.js should still have the take() that claims a prefetch");
  assert.match(take[1], /started\.delete\(path\)/);
  assert.match(app, /render\(\)\.finally\(\(\) => started\.clear\(\)\)/);

  // Every prefetched path has to be spelled the way the code that consumes it
  // spells it, or the read is done twice and the prefetch is pure cost.
  assert.match(app, /cachedGet\("\/overview"\)/);
  assert.match(app, /api\.get\(`\/threads\$\{threadsQuery\(\)\}`\)/);
  assert.match(app, /api\.get\(`\/threads\/\$\{id\}`\)/);
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

  // Every module in the graph, named where the browser sees it before it has
  // parsed app.js. Off the directory, not a list: forgetting one here is the
  // failure — it costs a serial round trip on any start the cache doesn't
  // answer, and a hand-written list would forget it the same way.
  const preloaded = [...shell.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((match) => match[1]);
  for (const name of readdirSync(PUBLIC_DIR).filter((file) => file.endsWith(".js") && file !== "sw.js")) {
    assert.ok(preloaded.includes(`/${name}`), `/${name} is part of the module graph and index.html doesn't preload it`);
  }
});

test("the phone layout subtracts the chrome it actually has", () => {
  const css = read("style.css");
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");

  // The threads screen is sized by subtraction, so every term has to be there:
  // the top bar (notch included) and the keyboard.
  const layout = css.match(/@media \(max-width: 768px\)[\s\S]*?\.threads-layout \{([\s\S]*?)\}/);
  assert.ok(layout, "the mobile block should still size .threads-layout");
  for (const term of ["100dvh", "var(--topbar)", "var(--keyboard, 0px)"]) {
    assert.ok(layout[1].includes(term), `.threads-layout must account for ${term}`);
  }

  // Not the home indicator, though: the screen runs to the bottom edge now, so
  // the strip it needs is left by whatever ends up sitting against that edge —
  // the last card of the list, and the composer of an open conversation.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(mobile, /\.thread-scroll \{ padding: [^;]*var\(--safe-b\)\); \}/);
  assert.match(mobile, /\.threads-layout\.pane-open \.composer \{ padding-bottom: calc\([^)]*var\(--safe-b\)\); \}/);

  // …and --keyboard only ever holds a number if app.js measures it. iOS slides
  // the keyboard over the page instead of resizing it, so dvh keeps reporting
  // the whole screen while the composer sits behind the keys.
  assert.match(app, /visualViewport/);
  assert.match(app, /setProperty\("--keyboard"/);
});

test("an open conversation stops paying for the bar it no longer shows", () => {
  const css = read("style.css");
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const mobileAt = css.indexOf("@media (max-width: 768px)");
  const mobile = css.slice(mobileAt);

  // The conversation has a header of its own and a ‹ back to the list, so the
  // bar above it is 3.25rem spent on a second wordmark. It goes — but hiding it
  // is only half: --topbar is what every height on this screen subtracts, so a
  // bar that disappears while the variable still holds its height leaves a dead
  // band at the top. Both facts have to move together, on the same condition.
  const hide = mobile.match(/([^\n{}]*\.topbar)\s*\{\s*display: none;\s*\}/);
  assert.ok(hide, "the mobile block should hide the top bar over an open conversation");
  const condition = hide[1].replace(/\s*\.topbar$/, "").trim();
  assert.match(condition, /:has\(\.threads-layout\.pane-open\)/);

  const override = mobile.match(/([^\n{}]*):has\(\.threads-layout\.pane-open\)[^\n{}]*\{\s*--topbar: ([^;]+);/);
  assert.ok(override, "hiding the bar has to drop --topbar too, or the height stays reserved");
  assert.match(override[2], /env\(safe-area-inset-top/); // the notch is all that is left above the pane
  assert.doesNotMatch(override[2], /3\.25rem/, "--topbar must stop counting a bar that is not on screen");

  // …and it has to be read *after* the base value, or the cascade quietly keeps
  // the bar's height.
  const base = mobile.indexOf("--topbar: calc(");
  assert.ok(base >= 0 && base < mobile.indexOf(override[0]), "the override must come after the :root default");

  // What makes the bar expendable is that the pane has another way back to the
  // list — the menu lives there, and the hamburger is now the only other door.
  assert.match(app, /"aria-label": "Back to threads"/);
  assert.match(app, /class: "thread-head"[\s\S]{0,80}backButton\(\)/);
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

test("an expanded group cannot push the page wider than the screen", () => {
  const css = read("style.css");

  // A collapse is a grid inside a flex column, and both of those size
  // themselves to their content unless told otherwise. So one un-shrinkable row
  // deep inside an open group — the topic name field is a fixed 11rem, and it
  // sits next to an id, two badges and a remove button — used to widen the
  // collapse, then the channel card, then the workspace card, until the whole
  // page overflowed sideways and every `truncate` above it stopped truncating.
  // Layout is not something these tests can run, so this holds the two
  // declarations that prevent it instead.
  assert.match(css, /\.collapse \{ display: grid; min-width: 0;/);
  assert.match(css, /\.collapse > \.collapse-content \{ min-width: 0; \}/);
  assert.match(css, /\.collapse > \.collapse-content > \* \{ min-width: 0; \}/);

  // And the row that started it wraps rather than insisting on its width.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(mobile, /\.topic-head \{ flex-wrap: wrap; \}/);
  assert.match(mobile, /\.topic-head > \.input \{ width: 100%; \}/);
  assert.match(readFileSync(join(PUBLIC_DIR, "app.js"), "utf8"), /class: "topic-head/);
});

test("the threads screen cancels the view's padding exactly", () => {
  const css = read("style.css");
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));

  // The list and the conversation each run edge to edge on a phone: no card,
  // no gutter. They get there with negative margins, which only works while
  // those are the view's own padding with the sign flipped — widen #view's
  // gutter and forget these, and the screen hangs off the side with a
  // horizontal scrollbar under it.
  const padding = mobile.match(/#view \{\s*padding: ([^;]+);/);
  const margin = mobile.match(/\.threads-layout \{\s*margin: ([^;]+);/);
  assert.ok(padding && margin, "the mobile block should set both #view's padding and the threads layout's margin");

  const [, right, bottom, left] = sides(padding[1]);
  const [, marginRight, marginBottom, marginLeft] = sides(margin[1]);
  // Not the top: the bar up there is fixed, so the screen has to keep clearing
  // it — only the gap under it is cancelled.
  const negated = (value: string) => value.replace("calc(", "calc(-").replace(" + ", " - ");
  assert.equal(marginRight, negated(right));
  assert.equal(marginBottom, negated(bottom));
  assert.equal(marginLeft, negated(left));
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

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
  const server = readFileSync(join(import.meta.dirname, "..", "src", "dashboard", "shell-files.ts"), "utf8");
  const served = server.match(/const SHELL_FILES = \[([\s\S]*?)\n\];/);
  assert.ok(served, "shell-files.ts should still declare SHELL_FILES");
  for (const module of modules) {
    assert.ok(served[1].includes(`"${module.slice(1)}"`), `${module} is part of the shell and shell-files.ts doesn't list it`);
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
  assert.match(revalidate[1], /refreshShell\(\)/);
  assert.match(revalidate[1], /postMessage\(\{ type: "shell-updated" \}\)/);
  const refresh = worker.match(/async function refreshShell\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(refresh, "the worker should still refresh the shell in one place");
  assert.match(refresh[1], /SHELL\.map/); // all of it, not just the html
  assert.match(refresh[1], /store\(cache, path, response\)/);
  // A file the worker never had is not a change — flagging it would reload the
  // page once for every asset added to the list since it was installed.
  assert.match(refresh[1], /previous && version\(previous\) !== version\(response\)/);

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
  assert.match(worker, /"install"[\s\S]{0,300}refreshShell\(\)/);
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

/** sw.js run for real, against a cache and a network held in memory: the
 *  worker's global scope, with `fetch` answering from `network` (a path mapped
 *  to the version it is at, or to nothing for a fetch that fails). */
function loadWorker(network: Map<string, string | undefined>) {
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: string) => store.get(key)?.clone(),
    put: async (key: string, response: Response) => { store.set(key, response); },
  };
  const posted: string[] = []; // serialized: the worker's objects are from another realm
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: { origin: "https://eleven.test" },
    addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener); },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message: unknown) => posted.push(JSON.stringify(message)) }] },
  };
  const fetch = async (path: string) => {
    const at = network.get(path);
    if (at === undefined) throw new TypeError("Load failed");
    const response = new Response(`${path}@${at}`, { headers: { etag: `"${at}"` } });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const context = vm.createContext({ self, caches: { open: async () => cache }, fetch, Response, Headers, URL });
  vm.runInContext(read("sw.js"), context);
  const shell = vm.runInContext("SHELL", context) as string[];
  const at = async (path: string) => (await store.get(path)?.clone().text())?.split("@")[1];
  /** Whether the worker answers a navigation itself or leaves it to the network. */
  const answersNavigation = (path: string) => {
    let answered = false;
    listeners.get("fetch")!({
      request: { method: "GET", mode: "navigate", url: `https://eleven.test${path}` },
      // What it answers with is beside the point here, and this fake has no cache to answer from.
      respondWith: (response: Promise<unknown>) => { answered = true; response.catch(() => {}); },
      waitUntil: () => {},
    });
    return answered;
  };
  return { shell, store, posted, at, answersNavigation, revalidate: () => vm.runInContext("revalidateShell()", context) as Promise<void> };
}

test("a shell that arrives in part is not written over a whole one", async () => {
  const network = new Map<string, string | undefined>();
  const worker = loadWorker(network);
  for (const path of worker.shell) {
    worker.store.set(path, new Response(`${path}@old`, { headers: { etag: '"old"' } }));
    network.set(path, "new");
  }
  // One file the cache never had, and the stylesheet cut off on the way — the
  // biggest file, so the one still in flight when the phone drops the fetch.
  worker.store.delete("/snapshot.js");
  network.set("/style.css", undefined);

  await worker.revalidate();
  // The html that names a tab bar stays out of the cache until the stylesheet
  // that draws one is in it too; nothing is announced, so no page reloads into
  // half of an update.
  assert.equal(await worker.at("/index.html"), "old");
  assert.equal(await worker.at("/app.js"), "old");
  assert.equal(await worker.at("/style.css"), "old");
  assert.deepEqual(worker.posted, []);
  // A hole is still filled: that file would have come from the network anyway.
  assert.equal(await worker.at("/snapshot.js"), "new");

  // The next open, with the whole set arriving, takes all of it and says so.
  network.set("/style.css", "new");
  await worker.revalidate();
  for (const path of worker.shell) assert.equal(await worker.at(path), "new", path);
  assert.deepEqual(worker.posted, [JSON.stringify({ type: "shell-updated" })]);
});

test("an auth proxy's sign-in callback reaches the proxy, not the cached shell", () => {
  const worker = loadWorker(new Map());
  // The app is opened at / and routes in the hash, so that is all the cache answers.
  assert.equal(worker.answersNavigation("/"), true);
  assert.equal(worker.answersNavigation("/index.html"), true);
  // Cloudflare Access sets its cookie on this navigation; answered from the
  // cache, the cookie is never set and the app comes up signed out again.
  assert.equal(worker.answersNavigation("/cdn-cgi/access/authorized?nonce=abc"), false);
  assert.equal(worker.answersNavigation("/oauth2/callback?code=abc"), false);
});

/** Every module the page is made of: app.js and whatever it imports, the
 *  vendored parser aside. Walked off the imports rather than the directory, so
 *  a scratch file another test leaves in public/ is not part of it. */
function pageSource() {
  const modules = new Map<string, string>();
  const visit = (name: string) => {
    if (modules.has(name) || name.startsWith("vendor/")) return;
    const text = read(name);
    modules.set(name, text);
    for (const [, next] of text.matchAll(/ from "\.\/([^"]+)";/g)) visit(next);
  };
  visit("app.js");
  return [...modules.values()].join("\n");
}

/** api.js's helpers, run against a fake browser: what an auth proxy's
 *  redirect looks like to the page, and where the page sends it. */
function apiHelpers(answer: { type: string; status?: number }) {
  const api = read("api.js");
  const pick = (from: string, to: string) => api.slice(api.indexOf(from), api.indexOf(to));
  const source = [
    pick("const call =", "\nconst api ="),
    pick("class SignInExpired", "\n/** Reads that were already in flight"),
  ].join("\n");
  const requests: { url: string; init: RequestInit }[] = [];
  const assigned: string[] = [];
  const session = new Map<string, string>();
  const context = vm.createContext({
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return { ok: false, statusText: "", json: async () => ({}), ...answer };
    },
    sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) },
    location: { assign: (url: string) => assigned.push(url), hash: "" },
    Date,
  });
  vm.runInContext(`${source}\nthis.read = (path) => call(path).then(ok); this.signIn = signIn;`, context);
  return { read: context.read as (path: string) => Promise<unknown>, signIn: context.signIn as (options?: object) => void, requests, assigned };
}

test("an auth proxy's expired session sends the page to sign in, not to 'can't reach the daemon'", async () => {
  // The service worker answers the shell from its cache, so an expired
  // Cloudflare Access session no longer turns the navigation into its sign-in
  // page. The API reads still go out, get a redirect to the proxy's origin, and
  // a followed redirect fails on CORS as a TypeError: the daemon looked down.
  const gated = apiHelpers({ type: "opaqueredirect", status: 0 });
  await assert.rejects(gated.read("/overview"), /sign-in expired/);
  assert.equal(gated.requests[0].url, "/api/overview");
  assert.equal(gated.requests[0].init.redirect, "manual");
  assert.deepEqual(gated.assigned, ["/api/signin"]);

  // The three boot reads all fail together; that is one trip to sign in. And a
  // proxy that redirects again right after a sign-in would loop the page
  // forever, so only the button on the error goes again inside the minute.
  await assert.rejects(gated.read("/threads"));
  assert.deepEqual(gated.assigned, ["/api/signin"]);
  gated.signIn({ force: true });
  assert.deepEqual(gated.assigned, ["/api/signin", "/api/signin"]);

  // A daemon error is still a daemon error.
  const failing = apiHelpers({ type: "basic", status: 500 });
  await assert.rejects(failing.read("/overview"), (error: Error) => error.constructor.name === "Error");
  assert.deepEqual(failing.assigned, []);

  // Every API request has to go through that helper, or it is the one that
  // still says the daemon is down. Across every module of the page: the one
  // that fetches on its own is the one this is looking for.
  const page = pageSource();
  assert.deepEqual(page.match(/fetch\(`\/api/g), ["fetch(`/api"], "only call() should fetch the API");
  assert.match(read("api.js"), /const call = \(path, init\) => fetch\(`\/api/);
  assert.match(read("router.js"), /error instanceof SignInExpired[\s\S]{0,300}signIn\(\{ force: true \}\)/);
});

test("the first screen's reads leave together", () => {
  const app = read("app.js"); // the boot
  const api = read("api.js");

  // With the shell cached, what is left of a cold start is the API — and the
  // router walks into those reads one at a time: /overview, then the list, then
  // the conversation the hash names. Three round trips through a tunnel, none
  // of which needs the one before it. The boot starts them all at once and
  // api.get takes whatever is already in flight for the path it is asked for.
  assert.match(api, /get: \(path\) => take\(path\) \?\? call\(path\)/);
  assert.match(app, /prefetch\("\/overview"\)/);
  assert.match(app, /prefetch\(`\/threads\$\{threadsQuery\(\)\}`\)/);
  assert.match(app, /prefetch\(`\/threads\/\$\{bootThread\}`\)/);

  // A prefetch is only ever taken once, and only by the boot render — an answer
  // nobody claimed is dropped rather than kept around to be served stale later.
  const take = api.match(/function take\(path\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(take, "api.js should still have the take() that claims a prefetch");
  assert.match(take[1], /started\.delete\(path\)/);
  assert.match(app, /render\(\)\.finally\(\(\) => \{[^}]*started\.clear\(\);\s*\}\)/);
  // A restored overview is painted in place of a read, so the real read still
  // in flight has to be claimed before that drop — or the page keeps the
  // snapshot's until the cache expires.
  const boot = app.slice(app.indexOf("render().finally("));
  assert.ok(boot.indexOf("refreshOverview()") < boot.indexOf("started.clear()"));

  // Every prefetched path has to be spelled the way the code that consumes it
  // spells it, or the read is done twice and the prefetch is pure cost: the
  // router's render, the list's read, and the open of a thread.
  assert.match(read("router.js"), /cachedGet\("\/overview"\)/);
  assert.match(read("threads.js"), /api\.get\(`\/threads\$\{threadsQuery\(\)\}`\)/);
  assert.match(read("thread-pane.js"), /api\.get\(`\/threads\/\$\{id\}`\)/);
});

test("a pairing request the snapshot didn't have gets its approve button, not just a badge", async () => {
  // The first screen is painted from the snapshot of the last run. The daemon's
  // overview lands after it and used to repaint only the sidebar badge, so the
  // workspaces view said 2 requests and showed none to approve.
  const socket = read("socket.js");
  const source = socket.slice(socket.indexOf("function refreshOverview()"), socket.indexOf("\n// Fetch a fresh overview"));
  const boot = (hash: string, snapshot: object, daemon: object) => {
    const rendered: unknown[] = [];
    const viewWorkspaces = () => {};
    const context = vm.createContext({
      state: { overview: snapshot },
      cachedGet: async () => daemon,
      keep: () => {},
      applyPairingBadge: () => {},
      render: () => rendered.push(context.state.overview),
      location: { hash },
      viewWorkspaces,
      routes: { threads: () => {}, workspaces: viewWorkspaces, channels: viewWorkspaces },
    });
    vm.runInContext(`${source}\nrefreshOverview();`, context);
    return new Promise<unknown[]>((resolve) => setImmediate(() => resolve(rendered)));
  };
  const queued = { pairing: [{ id: "a" }, { id: "b" }] };

  assert.deepEqual(await boot("#/workspaces", { pairing: [] }, queued), [queued]);
  assert.deepEqual(await boot("#/channels", { pairing: [] }, queued), [queued]);
  // Approved elsewhere since the snapshot: those buttons would act on nothing.
  assert.equal((await boot("#/workspaces", queued, { pairing: [] })).length, 1);
  // Nothing to correct, or nothing on screen that shows the queue: no repaint.
  assert.deepEqual(await boot("#/workspaces", queued, { ...queued }), []);
  assert.deepEqual(await boot("#/threads", { pairing: [] }, queued), []);
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

test("an installed iPhone app fills the screen from launch, not after a drag", () => {
  // Observed on 2026-09-28, iPhone installed app at launch: screen 852,
  // innerHeight/100dvh/body 793, 100vh 852 — the tab bar floated 59pt (the
  // status bar) over an empty strip until the page was dragged.
  const css = read("style.css");
  const html = read("index.html");

  // The mark has to be on <html> before the stylesheet paints the first frame.
  const mark = html.indexOf('classList.add("standalone")');
  assert.ok(mark > 0, "index.html should mark an installed app on <html>");
  assert.ok(mark < html.indexOf('href="/style.css"'), "the mark must come before the stylesheet");
  assert.match(html, /navigator\.standalone === true/);

  // Installed, the phone layout fills 100vh (the whole screen) and the root is
  // that tall; in a browser it keeps following the dynamic viewport.
  assert.match(css, /:root \{ --app-h: 100dvh; \}/);
  assert.match(css, /:root\.standalone \{ --app-h: 100vh; \}/);
  assert.match(css, /:root\.standalone, :root\.standalone body \{ height: 100vh; \}/);
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.doesNotMatch(mobile, /100dvh/, "phone rules must size from --app-h, never a bare 100dvh");
});

test("the phone layout subtracts the chrome it actually has", () => {
  const css = read("style.css");
  const phone = read("phone.js");

  // The threads screen is sized by subtraction, so every term has to be there:
  // the top bar (notch included) and the keyboard.
  const layout = css.match(/@media \(max-width: 768px\)[\s\S]*?\.threads-layout \{([\s\S]*?)\}/);
  assert.ok(layout, "the mobile block should still size .threads-layout");
  for (const term of ["var(--app-h)", "var(--topbar)", "var(--keyboard, 0px)"]) {
    assert.ok(layout[1].includes(term), `.threads-layout must account for ${term}`);
  }

  // Not the home indicator, though: the strip it needs is left by whatever ends
  // up sitting against the bottom edge — the tab bar under the list, and the
  // composer of an open conversation, where the tab bar is not.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(mobile, /--tabbar: calc\([^;]*var\(--safe-b\)\);/);
  assert.match(mobile, /\.tabbar \{[^}]*height: var\(--tabbar\);[^}]*padding: [^;]*var\(--safe-b\)/);
  assert.ok(layout[1].includes("var(--tabbar)"), ".threads-layout must stop at the tab bar");
  assert.match(mobile, /:root\.on-conversation \{[^}]*--tabbar: 0px;/);
  assert.match(mobile, /\.threads-layout\.pane-open \.composer \{ padding-bottom: calc\([^)]*var\(--safe-b\)\); \}/);

  // …and --keyboard only ever holds a number if phone.js measures it. iOS slides
  // the keyboard over the page instead of resizing it, so dvh keeps reporting
  // the whole screen while the composer sits behind the keys.
  assert.match(phone, /visualViewport/);
  assert.match(phone, /setProperty\("--keyboard"/);
});

test("an open conversation stops paying for the bar it no longer shows", () => {
  const css = read("style.css");
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
  assert.equal(condition, ":root.on-pane");

  const override = mobile.match(/:root\.on-pane \{\s*--topbar: ([^;]+);/);
  assert.ok(override, "hiding the bar has to drop --topbar too, or the height stays reserved");
  assert.match(override[1], /env\(safe-area-inset-top/); // the notch is all that is left above the pane
  assert.doesNotMatch(override[1], /3\.25rem/, "--topbar must stop counting a bar that is not on screen");

  // …and it has to be read *after* the base value, or the cascade quietly keeps
  // the bar's height.
  const base = mobile.indexOf("--topbar: calc(");
  assert.ok(base >= 0 && base < mobile.indexOf(override[0]), "the override must come after the :root default");

  // What makes the bar expendable is that the pane has another way back to the
  // list — the sections live there, in the tab bar that goes away with the bar.
  assert.match(read("phone.js"), /"aria-label": "Back to threads"/);
  assert.match(read("thread-head.js"), /class: "thread-head"[\s\S]{0,80}backButton\(\)/);
});

test("the launcher keeps the tab bar it opens on", () => {
  const css = read("style.css");
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));

  // The app lands on the launcher, so a launcher without the tab bar is a first
  // screen with no way to the other sections. The bar and the room the layout
  // leaves for it go on one condition, or the box sits under the bar.
  const hide = mobile.match(/([^\n{}]*) \.tabbar \{ display: none; \}/);
  assert.ok(hide, "the mobile block should hide the tab bar over an open conversation");
  const condition = hide[1].trim();
  assert.equal(condition, ":root.on-conversation");
  assert.ok(mobile.includes(`${condition} { --tabbar: 0px; }`), "--tabbar has to drop on the same condition the bar hides on");
  // …and that condition is a pane that is open and is not the launcher.
  assert.match(read("chrome.js"), /root\.toggle\("on-conversation", open && !composing\);/);

  // On the launcher the route already is #/threads, so the Threads link alone
  // would do nothing: the tap has to close the pane itself.
  assert.match(read("phone.js"), /\.tabbar a\[data-view="threads"\]'\)\.addEventListener\("click"[\s\S]{0,160}closePaneMobile\(\);/);
});

test("the chrome hears of every change to what the threads view is showing", () => {
  // The bars follow two classes on the root element instead of reading the
  // page with :has(): anchored on <body>, a :has() makes every insertion
  // anywhere under it a reason to restyle whatever hangs on any :has() at all,
  // and a streaming reply restyled the whole transcript per delta. The price
  // is that the script has to say so whenever either fact changes — every
  // time, in the same breath, because a layout measured in between is measured
  // against a bar that is no longer there.
  const rules = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(rules, /(?::root|html|body)[^\n{},]*:has\(/, "no :has() anchored on the root or the body");

  const sync = read("chrome.js").match(/function syncPaneChrome\(\) \{([\s\S]*?)\n\}/);
  assert.ok(sync, "chrome.js should still have syncPaneChrome");
  assert.match(sync[1], /getElementById\("threads-layout"\)\?\.classList\.contains\("pane-open"\)/);
  assert.match(sync[1], /getElementById\("thread-pane"\)\?\.classList\.contains\("is-composing"\)/);
  assert.match(sync[1], /root\.toggle\("on-pane", open\);/);

  // Every write of either class is followed at once by the sync…
  let writes = 0;
  for (const file of readdirSync(PUBLIC_DIR).filter((name) => name.endsWith(".js"))) {
    const source = read(file);
    for (const write of source.matchAll(/classList\.(?:add|remove|toggle)\([^)]*"(?:pane-open|is-composing)"[^)]*\);/g)) {
      writes++;
      const after = source.slice(write.index + write[0].length).trimStart();
      assert.ok(after.startsWith("syncPaneChrome();"), `${file}: ${write[0]} must be followed by syncPaneChrome()`);
    }
  }
  assert.ok(writes >= 4, "the classes are still written where this test looks for them");
  // …and so is the layout leaving the page, or being built again.
  assert.match(read("router.js"), /view\.replaceChildren\(loadFailure\(error\)\);\s*\}[\s\S]{0,120}syncPaneChrome\(\);/);
  assert.match(read("threads.js"), /id: "thread-pane" \}\),\s*\),\s*\);[\s\S]{0,120}syncPaneChrome\(\);/);
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
  // Observed on 2026-09-28 on an iPhone: Workspaces' collapses would not open
  // on a tap. The hidden checkbox over the title is the target, and iOS sizes a
  // native checkbox itself, so it only fills the title once it stops being one.
  assert.match(css, /\.collapse > input\[type="checkbox"\] \{[^}]*appearance: none;[^}]*width: 100%; height: 100%;/);
  assert.match(css, /\.collapse > \.collapse-content \{ min-width: 0; \}/);
  assert.match(css, /\.collapse > \.collapse-content > \* \{ min-width: 0; \}/);

  // And the row that started it wraps rather than insisting on its width.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(mobile, /\.topic-head \{ flex-wrap: wrap; \}/);
  assert.match(mobile, /\.topic-head > \.input \{ width: 100%; \}/);
  assert.match(read("workspaces.js"), /class: "topic-head/);
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

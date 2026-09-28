import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/* Opening a thread is a tap here and a read over there, and on a phone the pane
   slides over the list on the tap — so for the length of the read the reader is
   looking at a full screen of whatever the pane was holding before. It used to
   be holding the launcher (the screen a session lands on), which answered "open
   this conversation" with an empty composer titled NEW THREAD.

   The app is one script that boots itself against a live daemon, so what can be
   checked here is its source: that the pane is painted on the way *into* the
   read rather than only on the way out. */

const PUBLIC_DIR = join(import.meta.dirname, "..", "src", "dashboard", "public");
const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");

/** The body of a top-level function, from its signature to the closing brace in
 *  column one — the file's own formatting is what says where a function ends. */
function functionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} should still exist in app.js`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${signature} should be a top-level function`);
  return source.slice(start, end);
}

test("the pane stops showing the last screen before the read, not after it", () => {
  const open = functionBody(app, "async function openThread(id)");
  const painted = open.indexOf("paneLoading(id)");
  const read = open.indexOf("withLoading(read)");
  assert.ok(painted >= 0, "openThread should hand the pane over to a placeholder");
  assert.ok(read >= 0, "openThread should still read a thread it is not showing through withLoading");
  assert.ok(painted < read, "the placeholder has to be painted before the read is awaited, or it is not a placeholder");

  // Re-opening the thread already on screen is the common case — a turn ending,
  // the reconcile after a message — and blanking it there would flash the
  // transcript out from under whoever is reading it.
  assert.match(open, /if \(renderedThreadId !== id\) paneLoading\(id\);/);
});

test("a read that comes back empty puts the pane back", () => {
  const open = functionBody(app, "async function openThread(id)");
  const failure = open.slice(open.indexOf("withLoading(read)"));
  // Without this the placeholder is the last thing painted and stays up for
  // good: a thread that was deleted, or a phone that lost the tunnel mid-tap,
  // would leave a spinner spinning over nothing.
  assert.match(failure, /if \(!data && seq === openSeq\) renderThreadPane\(\);/);
});

test("the placeholder cannot be the launcher wearing a spinner", () => {
  const loading = functionBody(app, "function paneLoading(id)");
  // is-composing is what the launcher paints itself with; leaving it on would
  // keep its mobile padding and its "not a thread" state over the placeholder.
  assert.match(loading, /classList\.remove\("is-composing", "is-running"\)/);
  assert.match(loading, /replaceChildren\(/);
  // The pane is the whole screen on a phone. A read that stalls with no ‹ on it
  // is a room with no door.
  assert.match(loading, /backButton\(\)/);
  // Next paint has to rebuild rather than patch: there is no transcript, no
  // head and no composer in there to patch.
  assert.match(loading, /renderedThreadId = undefined/);
  // The clicked card already carries the name, so the head can say which thread
  // is coming instead of making the wait anonymous.
  assert.match(loading, /state\.threads\.find\(\(thread\) => thread\.id === id\)/);
  assert.match(loading, /thread-head-title/);

  assert.match(readFileSync(join(PUBLIC_DIR, "style.css"), "utf8"), /\.pane-loading \{/);
});

test("a conversation read before opens as it was, not as a spinner", () => {
  const loading = functionBody(app, "function paneLoading(id)");
  // The last read is painted first, and whole — the placeholder is only for a
  // thread this page has never read.
  const seen = loading.indexOf("seenThreads.get(id)");
  assert.ok(seen >= 0, "paneLoading should look for the last read of this thread");
  assert.ok(seen < loading.indexOf("pane-loading"), "the last read has to win over the spinner");
  assert.match(loading, /renderThreadPane\(\);\s*return;/);
  // ...but not what the turn was doing then: that is the part sure to be stale.
  assert.doesNotMatch(loading.slice(seen, loading.indexOf("pane-loading")), /state\.live\b/);

  // What is remembered is a read that is still current: taken after the check
  // that throws away an answer a newer open has overtaken.
  const open = functionBody(app, "async function openThread(id)");
  const stale = open.indexOf("if (!data || seq !== openSeq)");
  assert.ok(stale >= 0 && stale < open.indexOf("rememberThread(data)"));
});

test("a cold start paints what the page knew before anything is read", () => {
  // The snapshot is read before the first render, and what it holds is put
  // where the render looks: the overview in the read cache, the list in state,
  // the recent transcripts where paneLoading finds them.
  const restore = app.indexOf("await readSnapshot()");
  const render = app.indexOf("render().finally(");
  assert.ok(restore >= 0 && restore < render, "the snapshot has to be restored before the first render");
  const boot = app.slice(restore, render);
  assert.match(boot, /seedCache\("\/overview", restored\.overview\)/);
  assert.match(boot, /state\.threads = restored\.threads/);
  assert.match(boot, /rememberThread\(read, \{ persist: false \}\)/);
  // Only the unfiltered list is a first frame: opening on an old search's
  // answer would be wrong.
  assert.match(boot, /restored\.threads && !threadsQuery\(\)/);
  assert.match(functionBody(app, "async function refreshThreads()"), /if \(!threadsQuery\(\)\) keep\("threads", threads\);/);

  // And the list view only waits for the network when it has nothing to show.
  const view = functionBody(app, "async function viewThreads()");
  assert.match(view, /const reading = refreshThreads\(\);\s*if \(!state\.threads\.length\) await reading;/);
  // A deleted thread leaves the device too.
  assert.match(functionBody(app, "async function deleteThread(id)"), /forgetThread\(id\)/);
});

test("a thread painted before its pane is on screen still opens at the newest message", () => {
  // On a phone the pane is display:none until the slide puts it on screen, and
  // a thread read before is painted on the tap — before that. A hidden scroller
  // has no height, so scrollTop = scrollHeight lands on 0; the read after it
  // then saw a reader "scrolled up" at the first message and kept them there.
  const render = functionBody(app, "function renderThreadPane()");
  assert.match(render, /bottomOnShow = keepScroll === null && !messages\.clientHeight;/);
  // The wish survives the read that lands before the pane shows…
  assert.match(render, /const keepScroll = !opened && prev && !bottomOnShow && !atBottom\(prev\)/);
  // …and is granted the moment the transcript has a size.
  assert.match(render, /transcriptShown\.observe\(messages\)/);
  const observer = app.slice(app.indexOf("const transcriptShown = new ResizeObserver("));
  assert.match(observer.slice(0, observer.indexOf("\n});\n")), /if \(!bottomOnShow \|\| !el\?\.clientHeight\) return;[\s\S]*el\.scrollTop = el\.scrollHeight;/);
});

test("the document is put back when a phone leaves it scrolled under the tab bar", () => {
  // iOS scrolls the window to show a focused field and can leave it there once
  // the keyboard is gone: the fixed tab bar then floats over an empty strip
  // until the reader drags the page home by hand.
  const home = functionBody(app, "function homeDocument()");
  assert.match(home, /if \(typing\(\)\) return;/);
  assert.match(home, /window\.scrollTo\(0, 0\)/);
  for (const hook of [
    /document\.addEventListener\("focusout", \(\) => setTimeout\(homeDocument, 50\)\)/,
    /window\.addEventListener\("scroll", homeDocument/,
    /viewport\?\.addEventListener\("resize", homeDocument\)/,
    /window\.addEventListener\("pageshow", homeDocument\)/,
  ]) assert.match(app, hook);
});

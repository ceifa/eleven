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
  const read = open.indexOf("await withLoading");
  assert.ok(painted >= 0, "openThread should hand the pane over to a placeholder");
  assert.ok(read >= 0, "openThread should still read the thread through withLoading");
  assert.ok(painted < read, "the placeholder has to be painted before the read is awaited, or it is not a placeholder");

  // Re-opening the thread already on screen is the common case — a turn ending,
  // the reconcile after a message — and blanking it there would flash the
  // transcript out from under whoever is reading it.
  assert.match(open, /if \(renderedThreadId !== id\) paneLoading\(id\);/);
});

test("a read that comes back empty puts the pane back", () => {
  const open = functionBody(app, "async function openThread(id)");
  const failure = open.slice(open.indexOf("await withLoading"));
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

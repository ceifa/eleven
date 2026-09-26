import assert from "node:assert/strict";
import test from "node:test";
import { displayTitle, retitle, threadTitle } from "../src/threads/title.ts";

/* Every thread of a Telegram group used to be titled with the attribution the
   message arrives wrapped in, so a list of them read "[Gabriel @c3if4]
   [Replying to a message f…" top to bottom. */

const envelope = "[Gabriel @c3if4]\n[Replying to a message from Gabriel @c3if4]\n";

test("a title is what was said, not the envelope it arrived in", () => {
  assert.equal(threadTitle(`${envelope}Gosto muito do tema do nosso webapp`), "Gosto muito do tema do nosso webapp");
  assert.equal(threadTitle('[Ana]\n[Replying to you: "a quote with ] inside"]\nok then'), "ok then");
  // A bracket that opens the message itself is not an envelope line.
  assert.equal(threadTitle("[WIP] fix the build"), "[WIP] fix the build");
});

test("a title is clipped after the envelope comes off, not before", () => {
  const said = "x".repeat(120);
  assert.equal(threadTitle(`${envelope}${said}`), "x".repeat(80));
});

test("a title cut inside its envelope shows what it has rather than nothing", () => {
  const legacy = `${envelope}Gosto`.slice(0, 40); // "[Gabriel @c3if4]\n[Replying to a message"
  assert.equal(threadTitle(legacy), "");
  assert.equal(displayTitle(legacy), legacy);
  assert.equal(displayTitle(`${envelope}hello`), "hello");
  assert.equal(displayTitle(undefined), undefined);
});

test("the first message names the thread, and an envelope-only name gives way", () => {
  assert.deepEqual(retitle(undefined, `${envelope}hello`), { title: "hello" });
  assert.equal(retitle("hello", `${envelope}something else`), undefined);
  // A bare attachment still gets a name, rather than an untitled thread.
  const photo = "[Ana]\n[media attached: /tmp/a.jpg (image/jpeg)]";
  assert.deepEqual(retitle(undefined, photo), { title: photo });
  // ...and the next message that says something replaces it.
  assert.deepEqual(retitle(photo, "[Ana]\nwhat is this?"), { title: "what is this?" });
  assert.equal(retitle(photo, photo), undefined);
});

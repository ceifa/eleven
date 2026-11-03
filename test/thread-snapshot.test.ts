import assert from "node:assert/strict";
import test from "node:test";
import { threadSnapshot, THREAD_SNAPSHOT_CHARS, THREAD_CONTEXT_WARNING } from "../src/threads/snapshot.ts";
import type { ThreadItem } from "../src/threads/reader.ts";

const message = (text: string): ThreadItem => ({ kind: "message", role: "user", text });

test("snapshots keep recent prose in order, excluding tools and errors", () => {
  const timeline: ThreadItem[] = [message("old"), message("recent"),
    { kind: "tool-calls", calls: [{ id: "call", name: "read", summary: "secret" }] },
    { kind: "error", text: "secret error" }, message("newest")];
  const snapshot = threadSnapshot(timeline, 2);
  assert.deepEqual(snapshot.messages, [message("recent"), message("newest")]);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.warning, THREAD_CONTEXT_WARNING);
  assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)));
  snapshot.messages[0].text = "changed";
  assert.equal(timeline[1].text, "recent", "captured messages do not share mutable objects with the reader");
});

test("the character budget drops oldest messages first, even below the tail limit", () => {
  const snapshot = threadSnapshot([message("old"), message("x".repeat(THREAD_SNAPSHOT_CHARS - 10)), message("new".repeat(3))]);
  assert.equal(snapshot.messages.length, 2);
  assert.ok(snapshot.messages.reduce((sum, item) => sum + item.text.length, 0) <= THREAD_SNAPSHOT_CHARS);
  assert.equal(snapshot.truncated, true);
});

test("an oversized newest message is clipped and marked, not silently lost", () => {
  const snapshot = threadSnapshot([message("old"), message("x".repeat(THREAD_SNAPSHOT_CHARS * 3))]);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].text.length, THREAD_SNAPSHOT_CHARS);
  assert.ok(snapshot.messages[0].text.endsWith("…"));
  assert.equal(snapshot.truncated, true);
});

test("the default tail is twenty and empty or complete snapshots are not truncated", () => {
  assert.equal(threadSnapshot(Array.from({ length: 25 }, (_, i) => message(String(i)))).messages.length, 20);
  assert.equal(threadSnapshot([]).truncated, false);
  assert.equal(threadSnapshot([message("only")]).truncated, false);
});

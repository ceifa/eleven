import assert from "node:assert/strict";
import test from "node:test";
import { createProseBlocks } from "../src/agent/runner.ts";

/** Drives the accumulator the way the session's event stream does. */
function record() {
  const deltas: string[] = [];
  const blocks: string[] = [];
  const prose = createProseBlocks((delta) => deltas.push(delta), (block) => blocks.push(block));
  return { deltas, blocks, prose };
}

test("a message that speaks twice settles two blocks, not one wall of text", () => {
  // Regression: every block of a message was folded into a single string and
  // only settled at message_end, so a runtime narrating between its own tool
  // calls had no boundary a channel could send the first part on.
  const { deltas, blocks, prose } = record();
  prose.startMessage();
  prose.delta("Reading the file.");
  prose.endBlock();
  prose.delta("The caller is in bot.ts.");
  prose.endBlock();
  prose.endMessage("Reading the file.\n\nThe caller is in bot.ts.");

  assert.deepEqual(blocks, ["Reading the file.", "The caller is in bot.ts.", ""]);
  // The message ends with its blocks already settled: nothing is streamed twice.
  assert.deepEqual(deltas, ["Reading the file.", "The caller is in bot.ts."]);
});

test("a provider that streams nothing still delivers its text once", () => {
  const { deltas, blocks, prose } = record();
  prose.startMessage();
  prose.endMessage("the whole answer");
  assert.deepEqual(deltas, ["the whole answer"]);
  assert.deepEqual(blocks, ["the whole answer"]);
});

test("a message the provider finished past its deltas is caught up by the tail only", () => {
  const { deltas, blocks, prose } = record();
  prose.startMessage();
  prose.delta("half ");
  prose.endMessage("half and half");
  assert.deepEqual(deltas, ["half ", "and half"]);
  assert.deepEqual(blocks, ["half and half"]);
});

test("each message starts from nothing, however the last one ended", () => {
  const { blocks, prose } = record();
  prose.startMessage();
  prose.delta("first");
  prose.endMessage("first");
  prose.startMessage();
  // Shorter than the last message, and settled by it: a counter left standing
  // would swallow this text as if it had already been sent.
  prose.endMessage("ok");
  assert.deepEqual(blocks, ["first", "ok"]);
});

test("a message whose blocks settled is not re-streamed by how they read joined", () => {
  // Regression risk of settling blocks separately: message_end reports the whole
  // message, blocks joined as paragraphs — measuring that against what was
  // streamed would post the joining itself as a stray delta.
  const { deltas, blocks, prose } = record();
  prose.startMessage();
  prose.delta("one");
  prose.endBlock();
  prose.delta("two");
  prose.endBlock();
  prose.endMessage("one\n\ntwo");
  assert.deepEqual(deltas, ["one", "two"]);
  assert.deepEqual(blocks, ["one", "two", ""]);
});

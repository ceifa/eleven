import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createProseBlocks, followProse } from "../src/agent/runner.ts";

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

/** An assistant step from a Pi-native provider, streamed the way pi-ai streams one. */
function step(content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
  const message = {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    content.forEach((block, contentIndex) => {
      if (block.type !== "text") return;
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

test("a Pi-native model's narration goes out when it is written, not with the answer", async () => {
  // Regression: only Claude Code's loop reported narration mid-turn. A Pi-native
  // model (gpt on openai-codex) wrote "putting the map on the left wall" next to
  // its first tool call, and the chat got it twenty minutes later, glued on top
  // of the answer — after a photo that already showed the map in place.
  const timeline: string[] = [];
  const steps = [
    () => step([
      { type: "text", text: "Putting the map on the left wall." },
      { type: "toolCall", id: "call-1", name: "work", arguments: {} },
    ], "toolUse"),
    () => step([{ type: "text", text: "The map is on the left wall." }], "stop"),
  ];
  const work: AgentTool = {
    name: "work",
    label: "work",
    description: "does the work",
    parameters: Type.Object({}),
    execute: async () => {
      timeline.push("tool ran");
      return { content: [{ type: "text", text: "done" }], details: undefined };
    },
  };
  const agent = new Agent({
    initialState: { model: { id: "gpt", provider: "openai-codex", api: "openai-codex-responses" } as unknown as Model, tools: [work] },
    streamFn: (() => steps.shift()!()) as never,
  });
  const blocks: string[] = [];
  const prose = createProseBlocks(() => {}, (block) => block.trim() && blocks.push(block.trim()));
  agent.subscribe(followProse(prose, (text) => timeline.push(`interim: ${text}`)));

  await agent.prompt({ role: "user", content: "put the map there", timestamp: 1 });

  // Before the fix nothing reached onInterim: the narration only came out of
  // the turn's joined text, after the tool had run and the answer was written.
  assert.deepEqual(timeline, ["interim: Putting the map on the left wall.", "tool ran"]);
  // The answer itself is not narration — it stays for the turn's final delivery.
  assert.deepEqual(blocks, ["Putting the map on the left wall.", "The map is on the left wall."]);
});

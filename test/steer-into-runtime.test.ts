import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { boundRuntimeResults, keepRuntimeInputsInContext, withRuntimeInputs, withToolResults } from "../src/agent/runner.ts";
import { contentText } from "../src/util.ts";

const model = { id: "opus", provider: "claude-code", api: "claude-code", baseUrl: "local://claude-code" } as unknown as Model;

function human(text: string, timestamp: number): UserMessage {
  return { role: "user", content: text, timestamp };
}

function answer(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "claude-code",
    provider: "claude-code",
    model: "opus",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

/** A provider that settles immediately, recording the context it was given. */
function recordingStream(requests: string[][], onRequest?: () => void) {
  return ((_model: unknown, context: { messages: { content: unknown }[] }) => {
    requests.push(context.messages.map((message) => contentText(message.content)));
    onRequest?.();
    const stream = createAssistantMessageEventStream();
    const message = answer(`answer ${requests.length}`);
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  }) as never;
}

/**
 * The live bug, at the level it happens: Claude Code takes a message straight
 * off the wire mid-turn (eleven's fast path), a second message misses that
 * one-shot window and goes through Pi's steering queue, and the request Pi opens
 * for it is built from a context snapshot that predates the first one.
 */
test("a message handed to the runtime mid-turn is in the context of the turn's next request", async () => {
  const requests: string[][] = [];
  const injected: UserMessage[] = [];
  let taken = false;
  let agent!: Agent;
  agent = new Agent({
    initialState: { model },
    streamFn: recordingStream(requests, () => {
      if (taken) return;
      taken = true;
      // What steerIntoRuntime does: the child has the message, so eleven writes
      // it to the transcript and to Pi's state itself — the running loop knows
      // nothing about either.
      const message = human("e a mensagem ta muito grande", 2);
      injected.push(message);
      agent.state.messages.push(message);
      // The second message finds the input window closed and lands in Pi's queue.
      agent.steer(human("tb*", 3));
    }),
  });
  keepRuntimeInputsInContext({ agent } as unknown as AgentSession, () => injected);

  await agent.prompt(human("ainda tá pouco humano", 1));

  assert.deepEqual(requests[0], ["ainda tá pouco humano"]);
  // Before the fix this read ["ainda tá pouco humano", "answer 1", "tb*"]: the
  // human message the child answered was missing from the request, from its
  // payload log, and from anything that would have replayed this context.
  assert.deepEqual(requests[1], ["ainda tá pouco humano", "e a mensagem ta muito grande", "answer 1", "tb*"]);
  assert.equal(requests.length, 2);
});

test("the turn's context keeps pi's own next-turn preparation", async () => {
  const injected: UserMessage[] = [human("mid-turn", 2)];
  const prepared: string[] = [];
  const agent = {
    prepareNextTurnWithContext: (turn: { context: { messages: UserMessage[] } }) => {
      prepared.push("pi");
      assert.deepEqual(turn.context.messages, [human("original", 1), human("mid-turn", 2)], "compaction must see runtime history");
      // pi's own handler replaces the context (compaction) and the model.
      return { context: { ...turn.context, messages: [human("compacted", 1)] }, model };
    },
  };
  keepRuntimeInputsInContext({ agent } as unknown as AgentSession, () => injected);

  const update = await agent.prepareNextTurnWithContext({ context: { messages: [human("original", 1)] } } as never);

  assert.deepEqual(prepared, ["pi"]);
  assert.equal((update as { model?: Model }).model, model);
  assert.deepEqual((update as { context: { messages: UserMessage[] } }).context.messages, [human("compacted", 1)]);
});

test("runtime input lands where the transcript records it, and only once", () => {
  const seed = human("do the thing", 1);
  const mid = human("actually, wait", 2);
  const reply = answer("done");

  // Mid-turn input belongs before the answer that was being written when it
  // arrived — the same order the session file has.
  const spliced = withRuntimeInputs([seed, reply], [mid]);
  assert.deepEqual(spliced, [seed, mid, reply]);
  // The loop carries its context forward, so this runs again on its own output.
  assert.equal(withRuntimeInputs(spliced, [mid]), spliced);
  // A compaction mid-turn rebuilds the context from the transcript, so the same
  // message comes back as a different object — still the same message.
  const reloaded = [{ ...seed }, { ...mid }, { ...reply }];
  assert.equal(withRuntimeInputs(reloaded, [mid]), reloaded);
  // Nothing to add must leave pi's snapshot alone, array identity included.
  const untouched = [seed, reply];
  assert.equal(withRuntimeInputs(untouched, []), untouched);
  // A turn that used tools ends on its results: input goes after them, never
  // between a tool call and its result.
  const toolResult = { role: "toolResult" as const, content: [], toolCallId: "1", toolName: "read", isError: false, timestamp: 3 };
  assert.deepEqual(withRuntimeInputs([seed, reply, toolResult] as never, [mid]), [seed, reply, toolResult, mid]);
});

test("native calls and identical parallel results enter the next request only once", () => {
  const call: AssistantMessage = {
    ...answer(""), stopReason: "toolUse", timestamp: 2,
    content: [
      { type: "toolCall", id: "a", name: "Read", arguments: {} },
      { type: "toolCall", id: "b", name: "Read", arguments: {} },
    ],
  };
  const result = { role: "toolResult" as const, toolName: "Read", toolCallId: "a", content: [{ type: "text" as const, text: "" }], isError: false, timestamp: 3 };
  const otherResult = { ...result, toolCallId: "b" };
  const initial = human("read", 1);
  const final = answer("done");
  const history = [call, result, otherResult];
  const merged = withRuntimeInputs([initial, final], history);
  assert.deepEqual(merged, [initial, call, result, otherResult, final]);
  assert.equal(withRuntimeInputs(merged, history), merged);
  assert.deepEqual(withRuntimeInputs([initial, call, result, final], history), merged);
});

test("input steered during a native tool call cannot split the model's call/result pair", () => {
  const call: AssistantMessage = { ...answer(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "native", name: "Read", arguments: {} }] };
  const result = { role: "toolResult" as const, toolCallId: "native", toolName: "Read", content: [{ type: "text" as const, text: "actual output" }], isError: false, timestamp: 3 };
  const seed = human("read", 1);
  const mid = human("and then explain it", 2);
  const final = answer("done");
  const chronological = [seed, call, mid, result, final];
  const ordered = withToolResults(chronological);
  assert.deepEqual(ordered, [seed, call, result, mid, final]);
  assert.deepEqual(chronological, [seed, call, mid, result, final], "the dashboard retains arrival order");
  assert.equal(withToolResults(ordered), ordered);
  const interrupted = [seed, call, mid];
  assert.equal(withToolResults(interrupted), interrupted, "a missing result is not invented");
});

test("only Claude tool history from answered turns is shortened in model context", () => {
  const claudeCall = (id: string, args = {}): AssistantMessage => ({ ...answer(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name: "Read", arguments: args }] });
  const piCall: AssistantMessage = { ...claudeCall("pi"), provider: "openai-codex", api: "openai-codex-responses" } as AssistantMessage;
  const output = (id: string, text: string, image = false) => ({
    role: "toolResult" as const, toolCallId: id, toolName: "Read", isError: false, timestamp: 3,
    content: [{ type: "text" as const, text }, ...(image ? [{ type: "image" as const, data: "aW1n", mimeType: "image/png" }] : [])],
  });
  const long = "x".repeat(10_000);
  const written = claudeCall("ancient", { path: "a.txt", content: long, edits: [{ text: long }] });
  // Thirty heads of 2,000 characters fill the budget, so the oldest output no longer fits.
  const filler = Array.from({ length: 30 }, (_, i) => [claudeCall(`fill-${i}`), output(`fill-${i}`, long)]).flat();
  const messages = [
    human("first", 0), written, output("ancient", long), ...filler, answer("one"),
    human("read", 1), claudeCall("old"), output("old", long, true), claudeCall("small"), output("small", "short"),
    piCall, output("pi", long), answer("done"),
    human("again", 4), claudeCall("pending"), output("pending", long), { ...answer(""), stopReason: "error" } as AssistantMessage,
  ];
  const bounded = boundRuntimeResults(messages);
  const result = (id: string) => bounded.find((m) => m.role === "toolResult" && m.toolCallId === id)!;
  const original = (id: string) => messages.find((m) => m.role === "toolResult" && m.toolCallId === id)!;
  const text = (message: unknown) => JSON.stringify((message as { content: unknown }).content);
  assert.match(text(result("ancient")), /older output omitted/);
  assert.ok(text(result("ancient")).length < 200, "output past the budget is omitted");
  assert.match(text(result("fill-29")), /output shortened/, "newer outputs keep their head");
  const shortWrite = bounded[1];
  assert.ok(text(shortWrite).length < 1_000, "long call arguments are shortened at any depth");
  assert.match(text(shortWrite), /a\.txt/);
  assert.equal((written.content[0] as { arguments: { content: string } }).arguments.content, long);
  const shortened = result("old") as ReturnType<typeof output>;
  assert.equal(shortened.content.length, 1, "images are dropped");
  assert.ok(text(shortened).length < 2_300);
  assert.match(text(shortened), /10,000 characters/);
  assert.equal(result("small"), original("small"));
  assert.equal(result("pi"), original("pi"), "Pi-native output was already in context and stays as it was");
  assert.equal(result("pending"), original("pending"), "a turn that did not finish keeps its whole output for a continuation");
  assert.equal(boundRuntimeResults([human("hi", 1), answer("hello")]).length, 2);
});

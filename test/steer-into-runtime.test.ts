import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { keepRuntimeInputsInContext, withRuntimeInputs } from "../src/agent/runner.ts";
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
      // pi's own handler replaces the context (compaction) and the model.
      return { context: { ...turn.context, messages: [human("compacted", 1)] }, model };
    },
  };
  keepRuntimeInputsInContext({ agent } as unknown as AgentSession, () => injected);

  const update = await agent.prepareNextTurnWithContext({ context: { messages: [human("original", 1)] } } as never);

  assert.deepEqual(prepared, ["pi"]);
  assert.equal((update as { model?: Model }).model, model);
  assert.deepEqual((update as { context: { messages: UserMessage[] } }).context.messages, [human("compacted", 1), human("mid-turn", 2)]);
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

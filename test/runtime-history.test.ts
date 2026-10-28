import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";

const scratch = mkdtempSync(join(tmpdir(), "eleven-runtime-history-"));
process.env.ELEVEN_STATE_DIR = join(scratch, "state");
process.env.ELEVEN_CONFIG_DIR = join(scratch, "config");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const { createClaudeCodeProvider } = await import("../src/agent/claude-code.ts");
const { modelRuntime } = await import("../src/agent/pi.ts");
const { Runner } = await import("../src/agent/runner.ts");
const { readThreadTimeline, readToolResult } = await import("../src/threads/reader.ts");

const nativeMessages = [
  {
    type: "assistant", parent_tool_use_id: null, uuid: "assistant", session_id: "native",
    message: { role: "assistant", content: [{ type: "tool_use", id: "native-call", name: "Read", input: { file_path: "README.md" } }] },
  },
  {
    type: "user", parent_tool_use_id: null, uuid: "user", session_id: "native",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-call", content: "file contents only the tool returned" }] },
  },
  {
    type: "result", subtype: "success", is_error: false, result: "Read it.", session_id: "native", num_turns: 1,
    usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: {}, permission_denials: [], uuid: "result",
  },
] as SDKMessage[];

const readerModel = {
  id: "m", name: "History reader", api: "history-reader", provider: "history-reader", baseUrl: "local://history-reader",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
} as Model;

const received: Message[][] = [];
const readerStream = (_model: Model, context: TranscriptContext) => {
  received.push(context.messages);
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "I have the tool result." }], api: readerModel.api, provider: readerModel.provider,
    model: readerModel.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "text_delta", contentIndex: 0, delta: "I have the tool result.", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
};
modelRuntime.registerNativeProvider({
  id: "history-reader", name: "History reader", baseUrl: readerModel.baseUrl,
  auth: { apiKey: { name: "unused", resolve: async () => ({ auth: { apiKey: "unused" }, source: "stored" }) } },
  getModels: () => [readerModel], stream: readerStream, streamSimple: readerStream,
});

function installClaude(inputs?: { options: Options; prompt: SDKUserMessage }[], messages = nativeMessages) {
  let calls = 0;
  modelRuntime.registerNativeProvider(createClaudeCodeProvider({
    query: ((input: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
      const prompt = await input.prompt[Symbol.asyncIterator]().next();
      inputs?.push({ options: input.options, prompt: prompt.value! });
      yield* calls++ === 0 ? messages : messages.slice(-1);
    })(), {
      close() {}, interrupt: async () => {}, initializationResult: async () => ({ account: { email: "fixture@example.test" } }),
    }) as unknown as Query) as never,
    deleteSession: (async () => {}) as never,
  }));
}

test("a native tool result reaches another runtime in warm and reopened sessions, with one call in the dashboard", async () => {
  installClaude();
  received.length = 0;
  const runner = new Runner();
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const request = {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "sessions"), workspacePath: workspace, tools: ["read"] as const,
  };
  const liveCalls: string[] = [];
  const first = await runner.submit("thread", { ...request, tools: ["read"], models: [{ model: "claude-code/default" }], text: "Read README.md" }, {
    onToolCall: (_name, _args, id) => liveCalls.push(id),
  });
  assert.equal(first?.text, "Read it.");
  const sessionFile = first!.sessionFile;
  assert.deepEqual(await readToolResult(sessionFile, "native-call"), { output: "file contents only the tool returned", isError: false });
  assert.deepEqual(liveCalls, ["native-call"]);
  const timeline = await readThreadTimeline(sessionFile);
  assert.deepEqual(timeline.flatMap((row) => row.kind === "tool-calls" ? row.calls.map((call) => call.id) : []), ["native-call"]);
  for (const host of [runner, new Runner()]) {
    await host.submit("thread", { ...request, tools: ["read"], sessionFile, models: [{ model: "history-reader/m" }], text: "What did the file say?" });
    const context = received.at(-1)!;
    const call = context.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"));
    const result = context.find((m) => m.role === "toolResult");
    assert.ok(call, "the next runtime must know what ran");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.toolCallId, "native-call");
    assert.deepEqual(result.content, [{ type: "text", text: "file contents only the tool returned" }]);
  }
  const rebuilt = convertToLlm(SessionManager.open(sessionFile).buildSessionContext().messages);
  assert.equal(rebuilt.filter((m) => m.role === "toolResult").length, 1, "reopening must not duplicate results");
  assert.equal(readFileSync(sessionFile, "utf8").includes('"customType":"eleven:tool-calls"'), false);
});

test("recording native history does not bootstrap or replay it when Claude resumes", async () => {
  const inputs: { options: Options; prompt: SDKUserMessage }[] = [];
  installClaude(inputs);
  const runner = new Runner();
  const workspace = join(scratch, "resume-workspace");
  mkdirSync(workspace);
  const request = {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "resume-sessions"), workspacePath: workspace,
    tools: ["read" as const], models: [{ model: "claude-code/default" }],
  };
  const first = await runner.submit("resume-thread", { ...request, text: "Read README.md" });
  await runner.submit("resume-thread", { ...request, sessionFile: first!.sessionFile, text: "Tell me more." });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].options.resume, inputs[0].options.sessionId);
  assert.deepEqual(inputs[1].prompt.message.content, [{ type: "text", text: "Tell me more." }]);
});

test("a continuation reads completed native tool results after Claude fails mid-turn", async () => {
  installClaude(undefined, [...nativeMessages.slice(0, -1), {
    ...nativeMessages.at(-1)!, subtype: "error_during_execution", is_error: true, errors: ["quota exhausted"],
  } as SDKMessage]);
  let sessionFile: string | undefined;
  const runner = new Runner({ onTurnStart: (_id, file) => { sessionFile = file; } });
  const workspace = join(scratch, "failure-workspace");
  mkdirSync(workspace);
  const request = {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "failure-sessions"), workspacePath: workspace, tools: ["read" as const],
  };
  await assert.rejects(runner.submit("failed-thread", {
    ...request, models: [{ model: "claude-code/default" }, { model: "history-reader/m" }], text: "Read README.md",
  }), /quota exhausted/);
  assert.ok(sessionFile);
  await runner.submit("failed-thread", { ...request, sessionFile, models: [{ model: "history-reader/m" }], text: "Continue." });
  const result = received.at(-1)!.find((m) => m.role === "toolResult");
  assert.deepEqual(result?.content, [{ type: "text", text: "file contents only the tool returned" }]);
});

test("a message delivered during a native tool call stays after its result in the next provider request", async () => {
  const runner = new Runner();
  const workspace = join(scratch, "steer-workspace");
  mkdirSync(workspace);
  const request = {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "steer-sessions"), workspacePath: workspace, tools: ["read" as const],
    models: [{ model: "claude-code/default" }],
  };
  modelRuntime.registerNativeProvider(createClaudeCodeProvider({
    query: ((input: { prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
      const iterator = input.prompt[Symbol.asyncIterator]();
      const seed = await iterator.next();
      yield nativeMessages[0];
      await runner.submit("steer-thread", { ...request, text: "And explain it." });
      const mid = await iterator.next();
      yield nativeMessages[1];
      yield { ...nativeMessages[2], user_message_uuids: [seed.value!.uuid, mid.value!.uuid], queued_turn_count: 0 } as SDKMessage;
    })(), { close() {}, interrupt: async () => {}, initializationResult: async () => ({ account: { email: "fixture@example.test" } }) }) as unknown as Query) as never,
    deleteSession: (async () => {}) as never,
  }));
  const first = await runner.submit("steer-thread", { ...request, text: "Read README.md" });
  await runner.submit("steer-thread", { ...request, sessionFile: first!.sessionFile, models: [{ model: "history-reader/m" }], text: "Continue." });
  const messages = received.at(-1)!;
  const resultAt = messages.findIndex((m) => m.role === "toolResult");
  const midAt = messages.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("And explain it."));
  assert.ok(resultAt >= 0 && midAt > resultAt, "the wire must not synthesize a missing result before the steered input");
});

test("a provider picking up an answered Claude turn gets the head of large output, the transcript keeps all of it", async () => {
  const long = `HEAD ${"y".repeat(20_000)} TAIL`;
  installClaude(undefined, [nativeMessages[0], {
    ...nativeMessages[1], message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-call", content: long }] },
  } as SDKMessage, nativeMessages[2]]);
  const runner = new Runner();
  const workspace = join(scratch, "large-workspace");
  mkdirSync(workspace);
  const request = {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "large-sessions"), workspacePath: workspace, tools: ["read" as const],
  };
  const first = await runner.submit("large-thread", { ...request, models: [{ model: "claude-code/default" }], text: "Read the big file" });
  await runner.submit("large-thread", { ...request, sessionFile: first!.sessionFile, models: [{ model: "history-reader/m" }], text: "Summarize it." });
  const sent = JSON.stringify(received.at(-1)!.find((m) => m.role === "toolResult")?.content);
  assert.match(sent, /HEAD/);
  assert.doesNotMatch(sent, /TAIL/);
  assert.match(sent, /Run the tool again/);
  assert.equal((await readToolResult(first!.sessionFile, "native-call"))?.output, long);
});

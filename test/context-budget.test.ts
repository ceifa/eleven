import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const scratch = mkdtempSync(join(tmpdir(), "eleven-context-budget-"));
process.env.ELEVEN_STATE_DIR = join(scratch, "state");
process.env.ELEVEN_CONFIG_DIR = join(scratch, "config");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const { createClaudeCodeProvider } = await import("../src/agent/claude-code.ts");
const { modelRuntime } = await import("../src/agent/pi.ts");
const { Runner } = await import("../src/agent/runner.ts");
const { validate } = await import("../src/config.ts");

/** Context each fake model was sent, and the prompt size it reports back. */
const received: Record<string, Message[][]> = {};
const reportedInput: Record<string, number> = {};

function fakeModel(id: string): Model {
  return {
    id, name: id, api: `budget-${id}`, provider: "budget", baseUrl: "local://budget",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1_000,
  } as Model;
}

const models = ["a", "b"].map(fakeModel);
const stream = (model: Model, context: TranscriptContext) => {
  (received[model.id] ??= []).push(context.messages);
  const out = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: `answer from ${model.id}` }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: reportedInput[model.id] ?? 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: (reportedInput[model.id] ?? 1) + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  queueMicrotask(() => {
    out.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].type === "text" ? message.content[0].text : "", partial: message });
    out.push({ type: "done", reason: "stop", message });
    out.end();
  });
  return out;
};
modelRuntime.registerNativeProvider({
  id: "budget", name: "Budget", baseUrl: "local://budget",
  auth: { apiKey: { name: "unused", resolve: async () => ({ auth: { apiKey: "unused" }, source: "stored" }) } },
  getModels: () => models, stream, streamSimple: stream,
});

function setup(name: string) {
  const workspace = join(scratch, name);
  mkdirSync(workspace);
  return {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, `${name}-sessions`), workspacePath: workspace, tools: ["read" as const],
  };
}

/** Turns long enough that Pi's recent window cannot hold all of them. */
const bulky = (label: string) => `${label} ${"x".repeat(120_000)}`;

function compactions(sessionFile: string) {
  return readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type === "compaction");
}

test("compactAt compacts a 1M-window conversation once it passes the threshold, not near the window", async () => {
  for (const compactAt of [undefined, 250_000]) {
    const request = setup(`compact-at-${compactAt ?? "default"}`);
    const runner = new Runner();
    reportedInput.a = 300_000;
    const entry = { model: "budget/a", ...(compactAt ? { compactAt } : {}) };
    let sessionFile: string | undefined;
    for (const label of ["first", "second", "third"]) {
      sessionFile = (await runner.submit(request.workspacePath, { ...request, sessionFile, models: [entry], text: bulky(label) }))!.sessionFile;
    }
    assert.equal(compactions(sessionFile!).length > 0, compactAt !== undefined, `compactAt ${compactAt ?? "unset"}`);
  }
});

test("a model taking over a long conversation gets its recent part and where the rest is", async () => {
  const request = setup("handoff");
  const runner = new Runner();
  reportedInput.a = 400_000;
  received.b = [];
  let sessionFile: string | undefined;
  for (const label of ["opening request", "second", "third"]) {
    sessionFile = (await runner.submit("handoff", { ...request, sessionFile, models: [{ model: "budget/a" }], text: bulky(label) }))!.sessionFile;
  }
  await runner.submit("handoff", { ...request, sessionFile, models: [{ model: "budget/b" }], text: "Continue." });
  const sent = JSON.stringify(received.b.at(-1));
  assert.match(sent, /moved from budget\/a to budget\/b/);
  assert.ok(sent.includes(sessionFile!), "the next model must know where the full transcript is");
  assert.match(sent, /The earliest request in the omitted part, verbatim:\\n.*opening request/);
  assert.ok(sent.length < bulky("").length * 2, "the omitted turns must not be sent");
  const transcript = readFileSync(sessionFile!, "utf8");
  for (const label of ["opening request", "second", "third"]) assert.ok(transcript.includes(label), "the transcript keeps everything");
  assert.equal(compactions(sessionFile!).length, 1);
});

test("a model taking over a short conversation gets all of it", async () => {
  const request = setup("short-handoff");
  const runner = new Runner();
  reportedInput.a = 2_000;
  received.b = [];
  const first = await runner.submit("short-handoff", { ...request, models: [{ model: "budget/a" }], text: "Remember the word heron." });
  await runner.submit("short-handoff", { ...request, sessionFile: first!.sessionFile, models: [{ model: "budget/b" }], text: "Which word?" });
  assert.match(JSON.stringify(received.b.at(-1)), /heron/);
  assert.equal(compactions(first!.sessionFile).length, 0);
});

test("compactAt reaches Claude Code as its own auto-compact window", async () => {
  const seen: Options[] = [];
  modelRuntime.registerNativeProvider(createClaudeCodeProvider({
    query: ((input: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
      await input.prompt[Symbol.asyncIterator]().next();
      seen.push(input.options);
      yield {
        type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "native", num_turns: 1,
        usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: {}, permission_denials: [], uuid: "result",
      } as SDKMessage;
    })(), { close() {}, interrupt: async () => {}, initializationResult: async () => ({ account: { email: "fixture@example.test" } }) }) as unknown as Query) as never,
    deleteSession: (async () => {}) as never,
  }));
  const request = setup("claude-compact-at");
  const runner = new Runner();
  const first = await runner.submit("claude-compact-at", { ...request, models: [{ model: "claude-code/default", compactAt: 200_000 }], text: "Hi" });
  await runner.submit("claude-compact-at", { ...request, sessionFile: first!.sessionFile, models: [{ model: "claude-code/default" }], text: "Again" });
  assert.equal(seen[0].settings && typeof seen[0].settings === "object" ? seen[0].settings.autoCompactWindow : undefined, 200_000);
  assert.equal(seen[1].settings && typeof seen[1].settings === "object" ? seen[1].settings.autoCompactWindow : "unset", undefined);
});

test("compactAt outside what Claude Code accepts is rejected at load", () => {
  const config = (compactAt: number) => ({ dashboard: { port: 1, host: "x" }, models: [{ model: "budget/a", compactAt }], workspaces: {} });
  assert.throws(() => validate(config(50_000) as never), /compactAt/);
  assert.throws(() => validate(config(250_000.5) as never), /compactAt/);
  assert.doesNotThrow(() => validate(config(250_000) as never));
});

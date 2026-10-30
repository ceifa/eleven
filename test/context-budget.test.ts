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

test("compactAt outside what Claude Code accepts is rejected at load", () => {
  const config = (compactAt: number) => ({ dashboard: { port: 1, host: "x" }, models: [{ model: "budget/a", compactAt }], workspaces: {} });
  assert.throws(() => validate(config(50_000) as never), /compactAt/);
  assert.throws(() => validate(config(250_000.5) as never), /compactAt/);
  assert.doesNotThrow(() => validate(config(250_000) as never));
});

function installClaudeDouble(reply: (prompt: string) => SDKMessage[]) {
  const queries: { options: Options; prompt: string }[] = [];
  modelRuntime.registerNativeProvider(createClaudeCodeProvider({
    query: ((input: { options: Options; prompt: string | AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
      const prompt = typeof input.prompt === "string"
        ? input.prompt
        : JSON.stringify((await input.prompt[Symbol.asyncIterator]().next()).value?.message.content);
      queries.push({ options: input.options, prompt });
      yield* reply(prompt);
    })(), { close() {}, interrupt: async () => {}, initializationResult: async () => ({ account: { email: "fixture@example.test" } }) }) as unknown as Query) as never,
    deleteSession: (async () => {}) as never,
  }));
  return queries;
}

const result = (text: string, turns = 1) => ({
  type: "result", subtype: "success", is_error: false, result: text, session_id: "native", num_turns: turns,
  usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: {}, permission_denials: [], uuid: `result-${text}`,
}) as SDKMessage;

const answer = (context: number) => [{
  type: "assistant", parent_tool_use_id: null, uuid: "a", session_id: "native",
  message: {
    role: "assistant", content: [{ type: "text", text: "Done." }],
    usage: { input_tokens: 2, cache_read_input_tokens: context - 1_002, cache_creation_input_tokens: 1_000, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 } },
  },
} as SDKMessage, result("Done.")];

const compacted = [
  { type: "system", subtype: "compact_boundary", session_id: "native", uuid: "b", compact_metadata: { trigger: "manual", pre_tokens: 300_000 } } as SDKMessage,
  result("", 0),
];

test("compactAt reaches Claude Code as its own auto-compact window", async () => {
  const queries = installClaudeDouble(() => [result("Done.")]);
  const request = setup("claude-compact-at");
  const runner = new Runner();
  const first = await runner.submit("claude-compact-at", { ...request, models: [{ model: "claude-code/default", compactAt: 200_000 }], text: "Hi" });
  await runner.submit("claude-compact-at", { ...request, sessionFile: first!.sessionFile, models: [{ model: "claude-code/default" }], text: "Again" });
  const windows = queries.map(({ options }) => typeof options.settings === "object" ? options.settings.autoCompactWindow : "unset");
  assert.deepEqual(windows, [200_000, undefined]);
});

test("a large idle Claude conversation is compacted before its cache expires, and the next turn resumes the compaction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queries = installClaudeDouble((prompt) => prompt === "/compact" ? compacted : answer(350_000));
  const request = { ...setup("idle-compaction"), compactWhenIdle: () => true };
  const runner = new Runner();
  const models = [{ model: "claude-code/default" }];
  const first = await runner.submit("idle-compaction", { ...request, models, text: "Work on it" });
  t.mock.timers.tick(57 * 60_000);
  assert.equal(queries.length, 1, "nothing happens while the cache is fresh");
  t.mock.timers.tick(60_000);
  await t.waitFor(() => assert.equal(queries.length, 2));
  const compaction = queries[1];
  assert.equal(compaction.prompt, "/compact");
  assert.equal(compaction.options.resume, queries[0].options.sessionId, "it compacts the committed conversation");
  assert.equal(compaction.options.model, queries[0].options.model);
  assert.deepEqual(compaction.options.systemPrompt, queries[0].options.systemPrompt, "it repeats the turn's prompt so the cache is read");
  assert.deepEqual(compaction.options.tools, queries[0].options.tools);
  await t.waitFor(() => assert.match(readFileSync(first!.sessionFile, "utf8"), /eleven:claude-compaction/));
  await runner.submit("idle-compaction", { ...request, sessionFile: first!.sessionFile, models, text: "Back" });
  assert.equal(queries[2].options.resume, compaction.options.sessionId);
});

test("a Claude conversation that is small, gets a new message first, or may not compact while idle is left alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let open = true;
  const cases = [
    ["small", 250_000, false, () => true],
    ["dashboard", 350_000, false, undefined],
    ["archived since", 350_000, false, () => open],
    // Last: its second turn leaves a timer of its own pending.
    ["busy", 350_000, true, () => true],
  ] as const;
  for (const [name, context, interrupt, compactWhenIdle] of cases) {
    const queries = installClaudeDouble((prompt) => prompt === "/compact" ? compacted : answer(context));
    const request = { ...setup(`no-idle-compaction-${name.replace(" ", "-")}`), compactWhenIdle };
    const runner = new Runner();
    const models = [{ model: "claude-code/default" }];
    open = true;
    const first = await runner.submit(name, { ...request, models, text: "Work on it" });
    open = false;
    if (interrupt) {
      t.mock.timers.tick(30 * 60_000);
      await runner.submit(name, { ...request, sessionFile: first!.sessionFile, models, text: "One more thing" });
      t.mock.timers.tick(30 * 60_000);
    } else {
      t.mock.timers.tick(2 * 60 * 60_000);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(queries.every((query) => query.prompt !== "/compact"), `${name} must not compact`);
  }
});

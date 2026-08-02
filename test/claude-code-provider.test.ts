import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_CODE_MODELS,
  claudeAttemptId,
  claudeInputHash,
  cleanToolName,
  createClaudeCodeProvider,
  nativeToolsForPolicy,
  registerClaudeSession,
  runWithClaudeSession,
  unregisterClaudeSession,
} from "../src/agent/claude-code.ts";

const model = CLAUDE_CODE_MODELS[0] as Model;

function fakeState() {
  return {
    get: () => undefined,
    begin: () => {},
    markTool: () => {},
    commit: () => [],
    fail: (_sessionId: string, attemptId: string) => ({ toolActivity: false, removable: [attemptId] }),
    ackDeleted: () => {},
  } as never;
}

function user(text: string) {
  return { role: "user" as const, content: text, timestamp: 1 };
}

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "claude-code",
    provider: "claude-code",
    model: "default",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 2,
  };
}

function scriptedQuery(messages: SDKMessage[], capture: (input: unknown) => void) {
  return ((input: unknown) => {
    capture(input);
    const iterator = (async function* () { yield* messages; })();
    return Object.assign(iterator, {
      close() {},
      interrupt: async () => {},
      initializationResult: async () => ({ account: {} }),
    }) as unknown as Query;
  }) as never;
}

const successfulMessages = [
  {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "assistant-1",
    session_id: "session",
    message: {
      id: "message",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "session",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 2,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-1",
  },
] as unknown as SDKMessage[];

test("Claude Code exposes stable moving aliases and an explicit native tool policy", () => {
  assert.deepEqual(CLAUDE_CODE_MODELS.map((candidate) => candidate.id), ["default", "fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(nativeToolsForPolicy(["read"]), ["Read", "Glob", "Grep"]);
  assert.deepEqual(nativeToolsForPolicy(["bash", "write"]), ["Bash", "Write"]);
  assert.ok(nativeToolsForPolicy(undefined).includes("WebSearch"));
  assert.ok(nativeToolsForPolicy(undefined).includes("Task"));
  assert.equal(cleanToolName("mcp__eleven__telegram"), "telegram");
  assert.equal(cleanToolName("Read"), "Read");
});

test("Claude Code keeps native tools inside its own loop and reports clean activity", async () => {
  const piSessionId = "11111111-1111-4111-8111-111111111111";
  const calls: unknown[] = [];
  const deleted: string[] = [];
  const activity: string[] = [];
  registerClaudeSession(piSessionId, {
    cwd: "/tmp",
    workspaceTools: ["read"],
    customTools: [],
  });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages, (input) => calls.push(input)),
      deleteSession: (async (id: string) => { deleted.push(id); }) as never,
      state: fakeState(),
    });
    const registration = (await import("../src/agent/claude-code.ts"));
    registration.setClaudeToolListener(piSessionId, (name) => activity.push(name));
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("hello")], tools: [] };
    // An empty context.tools means a truly tool-less internal request. Main
    // agent turns carry their active tools, so include Read here.
    context.tools = [{ name: "read", description: "read", parameters: Type.Object({}) }];
    const events = [];
    for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId, reasoning: "high" })) {
      events.push(event);
    }

    assert.deepEqual(activity, ["Read"]);
    assert.equal(events.some((event) => event.type.startsWith("toolcall")), false);
    assert.equal(events.find((event) => event.type === "text_delta")?.delta, "done");
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.message.usage.totalTokens, 19);

    const call = calls[0] as { options: Record<string, unknown> };
    assert.deepEqual(call.options.tools, ["Read", "Glob", "Grep"]);
    assert.deepEqual(call.options.allowedTools, ["Read", "Glob", "Grep"]);
    assert.deepEqual(call.options.settingSources, []);
    assert.equal(call.options.strictMcpConfig, true);
    assert.equal(call.options.permissionMode, "dontAsk");
    assert.deepEqual(deleted, [claudeAttemptId(piSessionId, "default", context.messages)]);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("Claude turns fork deterministically from the last committed transcript prefix", async () => {
  const piSessionId = "22222222-2222-4222-8222-222222222222";
  const firstInput = [user("one")];
  const nextInput = [...firstInput, assistant("answer one"), user("two")];
  let captured: { options: Record<string, unknown> } | undefined;
  registerClaudeSession(piSessionId, { cwd: "/tmp", customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages, (input) => { captured = input as never; }),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = {
      systemPrompt: "eleven prompt",
      messages: nextInput,
      tools: [{ name: "read", description: "read", parameters: Type.Object({}) }],
    };
    for await (const _event of provider.streamSimple(model, context, { sessionId: piSessionId })) { /* drain */ }

    assert.equal(captured?.options.resume, claudeAttemptId(piSessionId, "default", firstInput));
    assert.equal(captured?.options.sessionId, claudeAttemptId(piSessionId, "default", nextInput));
    assert.equal(captured?.options.forkSession, true);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("an interrupted attempt resumes without replaying its original user input", async () => {
  const piSessionId = "44444444-4444-4444-8444-444444444444";
  const original = user("perform the operation");
  const wake = user("continue after restart");
  const activeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let captured: { prompt: AsyncGenerator<{ message: { content: Array<{ type: string; text?: string }> } }>; options: Record<string, unknown> } | undefined;
  let begun: unknown;
  const state = {
    get: () => ({
      cwd: "/tmp",
      active: { id: activeId, inputHash: claudeInputHash([original]), inputCount: 1, toolActivity: true },
      sessions: [activeId],
    }),
    begin: (_session: string, _cwd: string, attempt: unknown) => { begun = attempt; },
    markTool: () => {},
    commit: () => [activeId],
    fail: () => ({ toolActivity: true, removable: [] }),
    ackDeleted: () => {},
  } as never;
  registerClaudeSession(piSessionId, { cwd: "/tmp", workspaceTools: [], customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages.slice(1), (input) => { captured = input as never; }),
      deleteSession: (async () => {}) as never,
      state,
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [original, wake], tools: [] };
    for await (const _event of provider.streamSimple(model, context, { sessionId: piSessionId })) { /* drain */ }

    assert.equal(captured?.options.resume, activeId);
    assert.equal(captured?.options.forkSession, true);
    assert.ok(begun);
    const input = await captured?.prompt.next();
    const text = input?.value?.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.equal(text, "continue after restart");
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("standalone Pi compaction stays inside the owner context but receives no tools", async () => {
  const ownerId = "66666666-6666-4666-8666-666666666666";
  const summaryId = "77777777-7777-4777-8777-777777777777";
  let captured: { options: Record<string, unknown> } | undefined;
  let began = false;
  registerClaudeSession(ownerId, { cwd: "/tmp", customTools: [], workspaceTools: ["read", "web"] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages.slice(1), (input) => { captured = input as never; }),
      deleteSession: (async () => {}) as never,
      state: { ...fakeState(), begin: () => { began = true; } } as never,
    });
    const context: Context = { systemPrompt: "summarize", messages: [user("summarize this")], tools: [] };
    await runWithClaudeSession(ownerId, async () => {
      for await (const _event of provider.streamSimple(model, context, { sessionId: summaryId })) { /* drain */ }
    });
    assert.deepEqual(captured?.options.tools, []);
    assert.equal(captured?.options.persistSession, false);
    assert.equal(began, false);
  } finally {
    unregisterClaudeSession(ownerId);
  }
});

test("invalid MCP tool setup terminates the provider stream with an error", async () => {
  const piSessionId = "55555555-5555-4555-8555-555555555555";
  const invalid = {
    name: "bad tool",
    label: "Bad",
    description: "invalid name",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  } as never;
  registerClaudeSession(piSessionId, { cwd: "/tmp", customTools: [invalid] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery([], () => assert.fail("query must not start")),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = {
      systemPrompt: "eleven prompt",
      messages: [user("hello")],
      tools: [{ name: "bad tool", description: "bad", parameters: Type.Object({}) }],
    };
    const events = [];
    for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId })) events.push(event);
    assert.equal(events.at(-1)?.type, "error");
    if (events.at(-1)?.type === "error") assert.match(events.at(-1)!.error.errorMessage ?? "", /invalid MCP tool name/);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("only active Eleven custom tools are exposed through the Eleven MCP namespace", async () => {
  const piSessionId = "33333333-3333-4333-8333-333333333333";
  const fakeTool = {
    name: "telegram",
    label: "Telegram",
    description: "send to Telegram",
    parameters: Type.Object({ text: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "sent" }], details: undefined }),
  } as never;
  let captured: { options: Record<string, unknown> } | undefined;
  registerClaudeSession(piSessionId, { cwd: "/tmp", workspaceTools: [], customTools: [fakeTool] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages.slice(1), (input) => { captured = input as never; }),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = {
      systemPrompt: "eleven prompt",
      messages: [user("send it")],
      tools: [{ name: "telegram", description: "send", parameters: Type.Object({ text: Type.String() }) }],
    };
    for await (const _event of provider.streamSimple(model, context, { sessionId: piSessionId })) { /* drain */ }

    assert.deepEqual(captured?.options.tools, []);
    assert.deepEqual(captured?.options.allowedTools, ["mcp__eleven__telegram"]);
    assert.ok((captured?.options.mcpServers as Record<string, unknown>).eleven);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

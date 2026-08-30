import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_CODE_MODELS,
  claudeAttemptId,
  claudeInputHash,
  cleanToolName,
  createClaudeCodeProvider,
  nativeToolsForPolicy,
  registerClaudeSession,
  RESUME_PROMPT,
  runWithClaudeSession,
  setClaudeTaskListener,
  steerClaudeSession,
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

function resultMessage(text: string, uuid: string) {
  return {
    type: "result", subtype: "success", is_error: false, result: text, session_id: "session",
    duration_ms: 1, duration_api_ms: 1, num_turns: 2, total_cost_usd: 0,
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], uuid,
  } as unknown as SDKMessage;
}

/**
 * Reproduce the Agent SDK's real streaming-input contract: it consumes the seed
 * and a queued human message, then withholds its one final result until the
 * prompt iterable reaches EOF. It does not emit one result per input message.
 */
function steerableQuery(steer: () => void, seen: string[]) {
  return ((input: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const stream = input.prompt[Symbol.asyncIterator]();
    const iterator = (async function* () {
      const seed = await stream.next();
      seen.push(promptText(seed.value));
      // The message lands while Claude is still working on the seed prompt.
      steer();
      const steered = await stream.next();
      seen.push(promptText(steered.value));
      // Production deadlocked here: Eleven waited for the result while the SDK
      // waited for EOF, because Eleven left the prompt open for more steering.
      const end = await stream.next();
      assert.equal(end.done, true);
      yield resultMessage("answer to both messages", "result-1");
    })();
    return Object.assign(iterator, {
      close() {},
      interrupt: async () => {},
      initializationResult: async () => ({ account: {} }),
    }) as unknown as Query;
  }) as never;
}

/**
 * The other ordering the real CLI produces, observed on 2026-08-25: the steered
 * message lands while the model is already writing its last text block, so there
 * is no tool boundary left to inject it at. The CLI reads it off the iterable
 * into its own queue, settles the seed with a result of its own, and only then
 * dequeues the steered prompt and runs it as a second turn.
 */
function lateSteerQuery(steer: () => void, seen: string[]) {
  return ((input: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const stream = input.prompt[Symbol.asyncIterator]();
    const iterator = (async function* () {
      const seed = await stream.next();
      seen.push(promptText(seed.value));
      steer();
      const steered = await stream.next();
      seen.push(promptText(steered.value));
      const end = await stream.next();
      assert.equal(end.done, true);
      // The seed's answer settles first, with the steered prompt still queued.
      yield resultMessage("answer to the seed", "result-1");
      // Production broke out of the loop above and killed the child right here,
      // with the steered prompt already dequeued into Claude's transcript.
      yield resultMessage("answer to the steered message", "result-2");
    })();
    return Object.assign(iterator, {
      close() {},
      interrupt: async () => {},
      initializationResult: async () => ({ account: {} }),
    }) as unknown as Query;
  }) as never;
}

function promptText(message: SDKUserMessage | undefined): string {
  const content = message?.message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
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
  // Delegation is not a capability eleven grants — see tool-policy.test.ts.
  assert.equal(nativeToolsForPolicy(undefined).includes("Agent"), false);
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
    const preToolUse = ((call.options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown, id: string) => Promise<unknown>> }> })
      .PreToolUse[0]?.hooks[0])!;
    // Bash is the only native tool left that can detach: delegation is not a
    // capability eleven grants, so there is no Agent call to foreground.
    const foreground = await preToolUse({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "sleep 600", run_in_background: true },
    }, "bash-tool");
    assert.deepEqual(foreground, {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "sleep 600", run_in_background: false },
      },
    });
    assert.deepEqual(deleted, [claudeAttemptId(piSessionId, "default", context.messages)]);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("nothing in the runtime's own task stream reaches the turn's activity", async () => {
  const piSessionId = "aaaaaaaa-1111-4111-8111-111111111111";
  // Neither half of Claude's task stream is eleven's any more. The plan is the
  // workspace's, through its own tools on every provider; delegation is not a
  // capability eleven grants at all, so a native subagent roster is something no
  // turn can produce — and scraping one would draw rows for work eleven cannot
  // see the inside of. A runtime that emits these anyway is ignored.
  const taskMessages = [
    {
      type: "system", subtype: "task_started", task_id: "agent-1", description: "Review reuse",
      subagent_type: "general-purpose", task_type: "local_agent", uuid: "s1", session_id: "session",
    },
    {
      type: "system", subtype: "task_progress", task_id: "agent-1", description: "Review reuse",
      last_tool_name: "Grep", summary: "Checking duplicates", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 5000 },
      uuid: "s2", session_id: "session",
    },
    {
      type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed",
      summary: "Found one duplicate", output_file: "/tmp/out", usage: { total_tokens: 1500, tool_uses: 4, duration_ms: 7000 },
      uuid: "s3", session_id: "session",
    },
    successfulMessages[1],
  ] as unknown as SDKMessage[];
  const activities: Array<import("../src/agent/task-activity.ts").TaskActivityEvent> = [];
  registerClaudeSession(piSessionId, { cwd: "/tmp", workspaceTools: ["read"], customTools: [] });
  try {
    setClaudeTaskListener(piSessionId, (event) => activities.push(event));
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(taskMessages, () => {}),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("work")], tools: [] };
    for await (const _event of provider.streamSimple(model, context, { sessionId: piSessionId })) { /* drain */ }

    // Not a plan row, not an agent row. The only producers left are the
    // workspace's own tools, over the host handshake.
    assert.deepEqual(activities, []);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("a resume that reports jobs orphaned by an earlier process still answers the prompt", async () => {
  const piSessionId = "bbbbbbbb-1111-4111-8111-111111111111";
  // What Claude Code emits when a fork inherits background jobs from the process
  // that died with the previous turn: terminal notifications for task ids this
  // stream never saw start, then a zero-turn result for the injected report.
  const orphan = (taskId: string) => ({
    type: "system", subtype: "task_notification", task_id: taskId, status: "stopped",
    summary: "Orphaned by a previous Claude Code process exit and reported in an aggregate summary.",
    output_file: "", uuid: `n-${taskId}`, session_id: "session",
  });
  const messages = [
    orphan("bj3n4hjt3"),
    orphan("bu4nh8gbe"),
    {
      type: "result", subtype: "success", is_error: false, result: "", session_id: "session",
      duration_ms: 17, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [],
      origin: { kind: "task-notification" }, uuid: "noop-result",
    },
    ...successfulMessages,
  ] as unknown as SDKMessage[];
  const activities: Array<import("../src/agent/task-activity.ts").TaskActivityEvent> = [];
  registerClaudeSession(piSessionId, { cwd: "/tmp", workspaceTools: ["read"], customTools: [] });
  try {
    setClaudeTaskListener(piSessionId, (event) => activities.push(event));
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(messages, () => {}),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("work")], tools: [] };
    const events = [];
    for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId })) {
      events.push(event);
    }

    // The orphan report belongs to no agent of this turn.
    assert.deepEqual(activities, []);
    // And the turn is the one that followed it, not the empty no-op.
    assert.equal(events.find((event) => event.type === "text_delta")?.delta, "done");
    assert.equal(events.find((event) => event.type === "done")?.message.stopReason, "stop");
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

test("workflow subagents inherit only native read tools from the owner runtime", async () => {
  const ownerId = "88888888-8888-4888-8888-888888888888";
  const subagentId = "99999999-9999-4999-8999-999999999999";
  let captured: { options: Record<string, unknown> } | undefined;
  registerClaudeSession(ownerId, { cwd: "/tmp", customTools: [], workspaceTools: ["read", "bash", "web"] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages.slice(1), (input) => { captured = input as never; }),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = {
      systemPrompt: "workflow subagent",
      messages: [user("research")],
      tools: [
        { name: "read", description: "read", parameters: Type.Object({}) },
        { name: "structured_output", description: "output", parameters: Type.Object({}) },
      ],
    };
    await runWithClaudeSession(ownerId, async () => {
      for await (const _event of provider.streamSimple(model, context, { sessionId: subagentId })) { /* drain */ }
    });
    assert.deepEqual(captured?.options.tools, ["Read", "Glob", "Grep"]);
    assert.deepEqual(captured?.options.allowedTools, ["Read", "Glob", "Grep"]);
    assert.equal(captured?.options.persistSession, false);
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

test("a message steered into a live turn is answered inside that same turn", { timeout: 1_000 }, async () => {
  const piSessionId = "cccccccc-1111-4111-8111-111111111111";
  const seen: string[] = [];
  registerClaudeSession(piSessionId, { cwd: "/tmp", workspaceTools: ["read"], customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: steerableQuery(() => {
        assert.equal(steerClaudeSession(piSessionId, "Viu minha msg?"), true);
      }, seen),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("investigate the zip")], tools: [] };
    const events = [];
    for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId })) {
      events.push(event);
    }

    // Both human turns went through the one open input stream, in order.
    assert.deepEqual(seen, ["investigate the zip", "Viu minha msg?"]);
    const done = events.find((event) => event.type === "done");
    // The real SDK emits one result after processing both inputs.
    assert.equal(done?.message.content[0]?.type === "text" && done.message.content[0].text, "answer to both messages");
    assert.equal(done?.message.usage.totalTokens, 6);
    // The turn is over: a late steer must find no live stream and fall back to Pi.
    assert.equal(steerClaudeSession(piSessionId, "too late"), false);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("a steered message queued behind the seed's own result is still answered", { timeout: 1_000 }, async () => {
  const piSessionId = "cccccccc-2222-4222-8222-222222222222";
  const seen: string[] = [];
  registerClaudeSession(piSessionId, { cwd: "/tmp", workspaceTools: ["read"], customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: lateSteerQuery(() => {
        assert.equal(steerClaudeSession(piSessionId, "use the writing-skills skill"), true);
      }, seen),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("open the PR")], tools: [] };
    const events = [];
    for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId })) {
      events.push(event);
    }

    assert.deepEqual(seen, ["open the PR", "use the writing-skills skill"]);
    const done = events.find((event) => event.type === "done");
    const text = done?.message.content[0]?.type === "text" ? done.message.content[0].text : undefined;
    // Both results belong to this Pi turn, so both answers reach the user.
    assert.equal(text, "answer to the seed\n\nanswer to the steered message");
    // The Pi message the results collapse into owns their summed usage.
    assert.equal(done?.message.usage.totalTokens, 12);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("a zero-turn result carrying Claude's synthetic placeholder is not taken as the answer", async () => {
  const piSessionId = "cccccccc-1111-4111-8111-111111111111";
  // The same resume path as the orphaned-jobs case above, except the CLI does
  // not settle the injected report with empty prose: it attaches its own
  // synthetic placeholder. "No response requested." is a constant in the Claude
  // Code binary, next to "(no content)" and "<synthetic>" — it is what the CLI
  // says for a turn it never sent to a model, not something a model produced.
  // Treating it as prose makes eleven answer the user with that literal string
  // and close the stream while their real prompt is still queued.
  const messages = [
    {
      type: "result", subtype: "success", is_error: false, result: "No response requested.",
      session_id: "session", duration_ms: 12, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [],
      origin: { kind: "task-notification" }, uuid: "synthetic-noop-result",
    },
    ...successfulMessages,
  ] as unknown as SDKMessage[];

  registerClaudeSession(piSessionId, { cwd: "/tmp", customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(messages, () => {}),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("work")], tools: [] };
    const events = [];
    for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId })) {
      events.push(event);
    }

    const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.delta);
    assert.ok(
      !deltas.includes("No response requested."),
      `the placeholder must never reach the user, got ${JSON.stringify(deltas)}`,
    );
    // The real turn is the one that follows the skipped no-op.
    assert.deepEqual(deltas, ["done"]);
    assert.equal(events.find((event) => event.type === "done")?.message.stopReason, "stop");
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("the child is told how a resumed turn reaches the user", async () => {
  const piSessionId = "dddddddd-1111-4111-8111-111111111111";
  let captured: { options: { env?: Record<string, string> } } | undefined;
  registerClaudeSession(piSessionId, { cwd: "/tmp", customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: scriptedQuery(successfulMessages, (input) => { captured = input as never; }),
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("work")], tools: [] };
    for await (const _event of provider.streamSimple(model, context, { sessionId: piSessionId })) { /* drain */ }

    // Left unset, Claude Code resumes an interrupted turn with its own
    // terminal-shaped "Continue from where you left off." — which says nothing
    // about the reply being a chat message nobody will see if the turn ends quiet.
    assert.equal(captured?.options.env?.CLAUDE_CODE_RESUME_PROMPT, RESUME_PROMPT);
  } finally {
    unregisterClaudeSession(piSessionId);
  }
});

test("stopping a turn interrupts the CLI instead of only killing its transport", async () => {
  const piSessionId = "eeeeeeee-1111-4111-8111-111111111111";
  const controller = new AbortController();
  let interrupts = 0;
  let queried: (() => void) | undefined;
  const queryCalled = new Promise<void>((resolve) => { queried = resolve; });
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });

  // A CLI that keeps the stream open until it is asked to stop.
  const query = ((_input: unknown) => {
    queried?.();
    const iterator = (async function* () { await held; })();
    return Object.assign(iterator, {
      close() {},
      interrupt: async () => {
        interrupts++;
        release?.();
        return { still_queued: ["queued-1"] };
      },
      initializationResult: async () => ({ account: {} }),
    }) as unknown as Query;
  }) as never;

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  registerClaudeSession(piSessionId, { cwd: "/tmp", customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query,
      deleteSession: (async () => {}) as never,
      state: fakeState(),
    });
    const context: Context = { systemPrompt: "eleven prompt", messages: [user("work")], tools: [] };
    const events: { type: string }[] = [];
    const drained = (async () => {
      for await (const event of provider.streamSimple(model, context, { sessionId: piSessionId, signal: controller.signal })) {
        events.push(event);
      }
    })();

    await queryCalled;
    // Bound the test: the stream ends on the stop whether or not the CLI is
    // interrupted, so a regression fails the assertion instead of hanging.
    controller.signal.addEventListener("abort", () => release?.(), { once: true });
    controller.abort();
    await drained;

    assert.equal(interrupts, 1, "a stop must reach the CLI, not just kill the pipe under it");
    assert.equal(events.at(-1)?.type, "error", "the turn still ends aborted");
    // still_queued survives the interrupt and will run; Query.interrupt() has no
    // cancel_queued flag, so the least eleven can do is not hide it.
    assert.ok(
      warnings.some((line) => line.includes("queued-1")),
      `a queued message surviving the stop must be reported, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = realWarn;
    unregisterClaudeSession(piSessionId);
  }
});

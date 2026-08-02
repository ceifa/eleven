import {
  createSdkMcpServer,
  deleteSession,
  query as sdkQuery,
  tool as sdkTool,
  type Options,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceTool } from "../config.ts";
import { contentText } from "../util.ts";
import { logger } from "../log.ts";
import { claudeSessionState } from "./claude-session-state.ts";
import type { TaskActivityEvent, TaskActivityItem, TaskActivityUsage } from "./task-activity.ts";

const log = logger("claude-code");

export const CLAUDE_CODE_PROVIDER = "claude-code";
const MCP_SERVER = "eleven";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** Claude Code capabilities intentionally enabled when a workspace omits a
 * policy. This is an allowlist, not a denylist: new Claude tools never appear
 * in eleven by surprise. Product/cloud tools (cron, notifications, worktrees,
 * DesignSync, Workflow, etc.) stay out. */
const DEFAULT_NATIVE_TOOLS = [
  "Read", "Glob", "Grep", "Bash", "Edit", "Write",
  "WebFetch", "WebSearch",
  "Task", "SendMessage", "TaskOutput", "TaskStop",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
] as const;

const POLICY_TO_NATIVE: Record<WorkspaceTool, readonly string[]> = {
  read: ["Read", "Glob", "Grep"],
  bash: ["Bash"],
  edit: ["Edit"],
  write: ["Write"],
  web: ["WebFetch", "WebSearch"],
  agent: ["Task", "SendMessage", "TaskOutput", "TaskStop", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"],
};

const EFFORT = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

export interface ClaudeSessionRegistration {
  cwd: string;
  /** Workspace policy as written in eleven.json. Undefined means the curated default. */
  workspaceTools?: WorkspaceTool[];
  /** Executable, request-bound tools (Telegram today), never Pi's builtin tools. */
  customTools: AgentTool[];
}

interface RegisteredSession extends ClaudeSessionRegistration {
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onTaskActivity?: (event: TaskActivityEvent) => void;
  planTasks: Map<string, PlanTask>;
  agentTaskTitles: Map<string, string>;
}

interface PlanTask {
  id: string;
  subject: string;
  status: TaskActivityItem["status"];
  blockedBy: Set<string>;
}

const sessions = new Map<string, RegisteredSession>();
// Warm Pi sessions are evicted independently of Claude's durable session. Keep
// the plan mirror across those rebuilds; TaskList/TaskGet reconcile it whenever
// Claude reads its own task store again. The cap prevents abandoned threads
// from growing process memory forever.
const planTasksBySession = new Map<string, Map<string, PlanTask>>();
const MAX_PLAN_SESSION_CACHE = 256;
const activeOwner = new AsyncLocalStorage<string>();

export function registerClaudeSession(sessionId: string, registration: ClaudeSessionRegistration): void {
  let planTasks = planTasksBySession.get(sessionId);
  if (!planTasks) {
    planTasks = new Map();
    planTasksBySession.set(sessionId, planTasks);
    if (planTasksBySession.size > MAX_PLAN_SESSION_CACHE) planTasksBySession.delete(planTasksBySession.keys().next().value!);
  }
  sessions.set(sessionId, {
    ...registration,
    planTasks,
    agentTaskTitles: new Map(),
  });
}

export function unregisterClaudeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Narrow (or restore) the tool policy of a live registration — the runner
 * applies each model candidate's own allowlist before prompting it. */
export function setClaudeWorkspaceTools(sessionId: string, tools: WorkspaceTool[] | undefined): void {
  const session = sessions.get(sessionId);
  if (session) session.workspaceTools = tools;
}

/** Delete every hidden Claude transcript owned by one Pi session. */
export async function cleanupClaudeSessions(sessionId: string): Promise<void> {
  planTasksBySession.delete(sessionId);
  const state = claudeSessionState.remove(sessionId);
  if (!state) return;
  await deleteTracked(claudeSessionState, deleteSession, sessionId, state.cwd, state.garbage ?? []);
}

/** Retry transcript deletions that previously failed. Called by daily GC. */
export async function cleanupClaudeGarbage(): Promise<void> {
  await Promise.all(claudeSessionState.garbageEntries().map((entry) =>
    deleteTracked(claudeSessionState, deleteSession, entry.sessionId, entry.cwd, entry.ids),
  ));
}

/** Commit only after Pi has durably accepted the assistant message. Until then
 * the attempt remains recoverable if Eleven dies between SDK success and its
 * own transcript append. */
export async function commitClaudeSession(sessionId: string): Promise<void> {
  const state = claudeSessionState.get(sessionId);
  if (!state?.active) return;
  const stale = claudeSessionState.commit(sessionId, state.active.id);
  await deleteTracked(claudeSessionState, deleteSession, sessionId, state.cwd, stale);
}

/** Drop a successful-but-empty attempt that Runner chose not to accept. */
export async function abandonClaudeSession(sessionId: string): Promise<void> {
  const state = claudeSessionState.get(sessionId);
  if (!state?.active) return;
  const failed = claudeSessionState.fail(sessionId, state.active.id);
  await deleteTracked(claudeSessionState, deleteSession, sessionId, state.cwd, failed.removable);
}

export function runWithClaudeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  return activeOwner.run(sessionId, operation);
}

export function setClaudeToolListener(
  sessionId: string,
  listener: ((name: string, args: Record<string, unknown>) => void) | undefined,
): void {
  const session = sessions.get(sessionId);
  if (session) session.onToolCall = listener;
}

export function setClaudeTaskListener(
  sessionId: string,
  listener: ((event: TaskActivityEvent) => void) | undefined,
): void {
  const session = sessions.get(sessionId);
  if (session) session.onTaskActivity = listener;
}

export function nativeToolsForPolicy(policy: WorkspaceTool[] | undefined): string[] {
  if (policy === undefined) return [...DEFAULT_NATIVE_TOOLS];
  return [...new Set(policy.flatMap((name) => POLICY_TO_NATIVE[name] ?? []))];
}

function nativeToolsForNestedContext(toolNames: string[]): string[] {
  return toolNames.some((name) => ["read", "grep", "find", "ls"].includes(name))
    ? ["Read", "Glob", "Grep"]
    : [];
}

/** A deterministic UUID for one transactional Claude attempt. Each successful
 * Pi transcript prefix maps to one resumable Claude fork, so daemon restarts do
 * not need a second mapping store. */
export function claudeAttemptId(piSessionId: string, modelId: string, messages: Context["messages"]): string {
  const hash = createHash("sha256")
    .update("eleven/claude-code/session/v1\0")
    .update(piSessionId)
    .update("\0")
    .update(modelId)
    .update("\0")
    .update(claudeInputHash(messages))
    .digest("hex");
  // Agent SDK session ids are UUIDs. Stamp RFC 4122 version/variant bits into
  // the stable digest instead of keeping a separate random-id mapping.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${["8", "9", "a", "b"][parseInt(hash[16], 16) % 4]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function claudeInputHash(messages: Context["messages"]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(messageFingerprint))).digest("hex");
}

type ClaudeStateBackend = Pick<typeof claudeSessionState, "get" | "begin" | "markTool" | "commit" | "fail" | "ackDeleted">;

interface ClaudeProviderDeps {
  query: typeof sdkQuery;
  deleteSession: typeof deleteSession;
  state: ClaudeStateBackend;
}

const defaultDeps: ClaudeProviderDeps = { query: sdkQuery, deleteSession, state: claudeSessionState };

async function deleteTracked(
  state: ClaudeStateBackend,
  remove: typeof deleteSession,
  ownerSessionId: string,
  cwd: string,
  ids: string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  const results = await Promise.allSettled(unique.map((id) => remove(id, { dir: cwd })));
  state.ackDeleted(ownerSessionId, unique.filter((_id, index) => results[index].status === "fulfilled"));
}

export function createClaudeCodeProvider(overrides: Partial<ClaudeProviderDeps> = {}): Provider {
  const deps = { ...defaultDeps, ...overrides };
  return {
    id: CLAUDE_CODE_PROVIDER,
    name: "Claude Code",
    baseUrl: "local://claude-code",
    auth: {
      apiKey: {
        name: "Claude Code local login",
        // Auth is owned by the official runtime (`claude auth login`), not Pi.
        // The stream itself reports a stale/missing login; doctor performs a
        // full no-token initialization probe with useful guidance.
        resolve: async () => ({ auth: { apiKey: "local-claude-code" }, source: "claude auth" }),
        check: async () => (await probeClaudeCodeAuth(deps.query)).ok
          ? { type: "api_key", source: "claude auth" }
          : undefined,
      },
    },
    getModels: () => CLAUDE_CODE_MODELS,
    stream: (model, context, options) => streamClaudeCode(deps, model, context, options),
    streamSimple: (model, context, options) => streamClaudeCode(deps, model, context, options),
  };
}

export const claudeCodeProvider = createClaudeCodeProvider();

const MODEL_BASE = {
  api: "claude-code",
  provider: CLAUDE_CODE_PROVIDER,
  baseUrl: "local://claude-code",
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 64_000,
};

export const CLAUDE_CODE_MODELS: readonly Model<Api>[] = [
  { ...MODEL_BASE, id: "default", name: "Claude Code · Default", contextWindow: 1_000_000 },
  { ...MODEL_BASE, id: "fable", name: "Claude Code · Fable", contextWindow: 1_000_000 },
  { ...MODEL_BASE, id: "opus", name: "Claude Code · Opus", contextWindow: 1_000_000 },
  { ...MODEL_BASE, id: "sonnet", name: "Claude Code · Sonnet", contextWindow: 200_000 },
  { ...MODEL_BASE, id: "haiku", name: "Claude Code · Haiku", contextWindow: 200_000 },
];

function streamClaudeCode(
  deps: ClaudeProviderDeps,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void consumeClaudeQuery(deps, model, context, options, stream);
  return stream;
}

async function consumeClaudeQuery(
  deps: ClaudeProviderDeps,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const output = emptyAssistant(model);
  stream.push({ type: "start", partial: output });

  const requestSessionId = options?.sessionId;
  const ownerSessionId = activeOwner.getStore() ?? requestSessionId;
  const registration = ownerSessionId ? sessions.get(ownerSessionId) : undefined;
  if (!requestSessionId || !ownerSessionId || !registration) {
    return failStream(stream, output, "Claude Code provider has no active eleven session context");
  }

  // Pi's compactor creates a one-off provider session id inside the owning
  // AgentSession call stack. It must not inherit tools or mutate the durable
  // conversational Claude lineage.
  const isolated = requestSessionId !== ownerSessionId;
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (options?.signal?.aborted) onAbort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });

  let inputDone: (() => void) | undefined;
  let sdk: Query | undefined;
  let attemptId: string | undefined;
  let stateBegan = false;

  try {
    let currentStart = trailingUserStart(context.messages);
    if (currentStart === context.messages.length) throw new Error("Claude Code provider received no user message");

    const persisted = isolated ? undefined : deps.state.get(ownerSessionId);
    const active = persisted?.active;
    let baseId: string | undefined;
    let bootstrap = true;
    let recovering = false;

    if (active) {
      const prefix = context.messages.slice(0, active.inputCount);
      const prefixMatches = prefix.length === active.inputCount && claudeInputHash(prefix) === active.inputHash;
      // A prior subprocess died after accepting this input. Its hidden Claude
      // transcript is the side-effect authority even if Pi lost its deferred
      // first-turn file or compacted its visible prefix meanwhile. Resume it
      // and send only input that arrived after the crash; never replay the old
      // user request from a reconstructed Pi transcript.
      baseId = active.id;
      currentStart = prefixMatches ? active.inputCount : trailingUserStart(context.messages);
      bootstrap = false;
      recovering = true;
    }

    if (!baseId && !isolated) {
      const history = context.messages.slice(0, currentStart);
      const previous = history.at(-1);
      const canResume = previous?.role === "assistant"
        && previous.provider === CLAUDE_CODE_PROVIDER
        && previous.stopReason === "stop";
      if (canResume) {
        baseId = persisted?.committed ?? claudeAttemptId(ownerSessionId, previous.model, history.slice(0, -1));
        bootstrap = false;
      }
    }

    attemptId = claudeAttemptId(isolated ? requestSessionId : ownerSessionId, model.id, context.messages);
    if (attemptId === baseId) attemptId = randomUUID();
    if (!recovering) {
      try {
        await deps.deleteSession(attemptId, { dir: registration.cwd });
      } catch {
        // Never append into a stale deterministic fork whose deletion failed.
        attemptId = randomUUID();
      }
    }

    const seenToolCalls = new Set<string>();
    const seenToolSignatures = new Set<string>();
    const markTool = (name: string, args: Record<string, unknown>, id?: string) => {
      const cleanName = cleanToolName(name);
      const signature = `${cleanName}\0${JSON.stringify(args)}`;
      if ((id && seenToolCalls.has(id)) || seenToolSignatures.has(signature)) return;
      if (id) seenToolCalls.add(id);
      seenToolSignatures.add(signature);
      if (!isolated) deps.state.markTool(ownerSessionId);
      registration.onToolCall?.(cleanName, args);
    };

    const activeCustomNames = new Set(context.tools?.map((tool) => tool.name) ?? []);
    const customTools = isolated ? [] : registration.customTools.filter((tool) => activeCustomNames.has(tool.name));
    // Standalone calls are either Pi compaction (no tools) or workflow
    // subagents (read-only Pi tools). They share the owner's cwd through
    // AsyncLocalStorage but never its side-effectful MCP tools or session state.
    const nativeTools = isolated
      ? nativeToolsForNestedContext(context.tools?.map((tool) => tool.name) ?? [])
      : nativeToolsForPolicy(registration.workspaceTools);
    const mcpServer = buildMcpServer(customTools, ownerSessionId, markTool);
    const qualifiedTools = customTools.map((tool) => `${MCP_PREFIX}${tool.name}`);

    if (!isolated) {
      deps.state.begin(ownerSessionId, registration.cwd, {
        id: attemptId,
        inputHash: claudeInputHash(context.messages),
        inputCount: context.messages.length,
      });
      stateBegan = true;
    }

    let releaseInput!: () => void;
    const inputClosed = new Promise<void>((resolve) => (releaseInput = resolve));
    inputDone = releaseInput;
    const prompt = promptStream(context, currentStart, bootstrap, inputClosed);
    let result: SDKMessage | undefined;
    let lastTopLevelText = "";

    const logicalPayload = {
      runtime: "claude-code",
      model: model.id,
      cwd: registration.cwd,
      resume: baseId,
      sessionId: attemptId,
      tools: nativeTools,
      mcpTools: qualifiedTools,
      systemPrompt: context.systemPrompt,
      messages: context.messages,
    };
    // Eleven's hook records this logical invocation. The Agent SDK deliberately
    // does not expose its private wire request for mutation.
    await options?.onPayload?.(logicalPayload, model);

    const sdkOptions: Options = {
      cwd: registration.cwd,
      model: model.id,
      systemPrompt: { type: "preset", preset: "claude_code", append: context.systemPrompt },
      tools: nativeTools,
      allowedTools: [...nativeTools, ...qualifiedTools],
      permissionMode: "dontAsk",
      mcpServers: mcpServer ? { [MCP_SERVER]: mcpServer } : {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: !isolated,
      sessionId: attemptId,
      ...(baseId ? { resume: baseId, forkSession: true } : {}),
      ...(options?.reasoning
        ? { thinking: { type: "adaptive" as const }, effort: EFFORT[options.reasoning] }
        : { thinking: { type: "disabled" as const } }),
      hooks: {
        PreToolUse: [{
          hooks: [async (input, toolUseId) => {
            if (input.hook_event_name !== "PreToolUse") return { continue: true };
            const args = asArgs(input.tool_input);
            markTool(input.tool_name, args, toolUseId);
            const updatedInput = foregroundToolInput(input.tool_name, args);
            return updatedInput
              ? { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, updatedInput } }
              : { continue: true };
          }],
        }],
      },
      abortController,
      includePartialMessages: false,
      env: claudeChildEnv(),
      stderr: (line) => log.warn(line.trim()),
    };

    const taskCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
    const hiddenAgentTasks = new Set<string>();
    sdk = deps.query({ prompt, options: sdkOptions });
    for await (const message of sdk) {
      if (message.type === "assistant") {
        if (message.parent_tool_use_id === null) lastTopLevelText = assistantText(message);
        for (const block of message.message.content) {
          if (block.type !== "tool_use") continue;
          const args = asArgs(block.input);
          markTool(block.name, args, block.id);
          if (isPlanTool(block.name)) taskCalls.set(block.id, { name: block.name, input: args });
        }
      } else if (message.type === "user") {
        if (!isolated) applyPlanToolResults(registration, taskCalls, message);
      } else if (message.type === "system") {
        if (!isolated) emitAgentTaskActivity(registration, hiddenAgentTasks, message);
      } else if (message.type === "result") {
        result = message;
        break; // streaming input stays open for MCP; the result closes this turn
      }
    }

    if (!result || result.type !== "result") throw new Error("Claude Code ended without a result");
    const error = sdkResultError(result);
    if (error) throw new Error(error);
    const text = result.subtype === "success" ? (result.result || lastTopLevelText) : lastTopLevelText;
    applyUsage(output, result);
    if (text) {
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
    }
    // The owning Runner commits this active attempt only after Pi has accepted
    // the assistant message into its own transcript (see commitClaudeSession).
    output.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  } catch (error) {
    try { sdk?.close(); } catch { /* already closed */ }
    sdk = undefined;
    const errorText = error instanceof Error ? error.message : String(error);
    if (!isolated && stateBegan && attemptId) {
      const failed = deps.state.fail(ownerSessionId, attemptId);
      await deleteTracked(deps.state, deps.deleteSession, ownerSessionId, registration.cwd, failed.removable);
      // A crash before the CLI created its transcript leaves an active marker
      // but nothing resumable. It is safe to discard only when no tool ever ran;
      // toolful missing sessions remain fail-closed to prevent replay.
      const restored = deps.state.get(ownerSessionId)?.active;
      if (restored && !restored.toolActivity && /(?:no conversation|session).*(?:found|exist)/i.test(errorText)) {
        const abandoned = deps.state.fail(ownerSessionId, restored.id);
        await deleteTracked(deps.state, deps.deleteSession, ownerSessionId, registration.cwd, abandoned.removable);
      }
    }
    if (abortController.signal.aborted || options?.signal?.aborted) {
      output.stopReason = "aborted";
      output.errorMessage = "Operation aborted";
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
    } else {
      failStream(stream, output, errorText);
    }
  } finally {
    inputDone?.();
    options?.signal?.removeEventListener("abort", onAbort);
    try { sdk?.close(); } catch { /* already closed */ }
    if (isolated && attemptId) await deps.deleteSession(attemptId, { dir: registration.cwd }).catch(() => {});
  }
}
function buildMcpServer(
  customTools: AgentTool[],
  ownerSessionId: string,
  onBeforeTool: (name: string, args: Record<string, unknown>, id?: string) => void,
) {
  if (!customTools.length) return undefined;
  const names = new Set<string>();
  const tools = customTools.map((tool) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) throw new Error(`invalid MCP tool name: ${tool.name}`);
    if (names.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`);
    names.add(tool.name);
    const schema = z.fromJSONSchema(tool.parameters as never);
    if (!(schema instanceof z.ZodObject)) throw new Error(`${tool.name}: MCP parameters must be an object schema`);
    return sdkTool(
      tool.name,
      tool.description,
      schema.shape,
      async (args, extra) => {
        const request = (extra ?? {}) as { requestId?: string; signal?: AbortSignal };
        try {
          onBeforeTool(tool.name, args, request.requestId);
          const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
          // MCP callbacks cross the SDK transport boundary. Re-enter the owner
          // explicitly so extension tools that spawn nested AgentSessions
          // (workflow) inherit Claude's cwd/provider bridge.
          const result = await activeOwner.run(ownerSessionId, () =>
            tool.execute(request.requestId ?? randomUUID(), prepared, request.signal, undefined),
          );
          return {
            content: result.content.map((block) => block.type === "image"
              ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
              : { type: "text" as const, text: block.text }),
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
      { alwaysLoad: true },
    );
  });
  return createSdkMcpServer({ name: MCP_SERVER, version: "1.0.0", tools, alwaysLoad: true });
}

async function* promptStream(
  context: Context,
  currentStart: number,
  bootstrap: boolean,
  done: Promise<void>,
): AsyncGenerator<SDKUserMessage> {
  const current = context.messages.slice(currentStart);
  const blocks: Array<Record<string, unknown>> = [];
  if (bootstrap && currentStart > 0) {
    blocks.push({
      type: "text",
      text: `The conversation before this turn happened in another runtime. Continue it faithfully from this transcript:\n\n${formatTranscript(context.messages.slice(0, currentStart))}`,
    });
  }
  for (const message of current) {
    if (message.role !== "user") continue; // failed-attempt assistant envelopes are not new human input
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of content) {
      if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
      if (block.type === "image") {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: block.mimeType, data: block.data },
        });
      }
    }
  }
  yield {
    type: "user",
    message: { role: "user", content: blocks as never },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
  await done;
}

function formatTranscript(messages: Context["messages"]): string {
  return messages.map((message) => {
    const extended = message as unknown as { role: string; summary?: string; content?: unknown };
    if (extended.role === "compactionSummary") return `Conversation summary: ${extended.summary ?? "[unavailable]"}`;
    if (message.role === "toolResult") return `Tool result (${message.toolName}): ${contentText(message.content)}`;
    const label = message.role === "assistant" ? "Assistant" : "User";
    const text = contentText(message.content);
    const toolCalls = message.role === "assistant"
      ? message.content.filter((block) => block.type === "toolCall").map((block) => `[called ${block.name} ${JSON.stringify(block.arguments)}]`).join("\n")
      : "";
    return `${label}: ${[text, toolCalls].filter(Boolean).join("\n") || "[non-text content]"}`;
  }).join("\n\n");
}

function trailingUserStart(messages: Context["messages"]): number {
  let index = messages.length;
  while (index > 0 && messages[index - 1].role === "user") index--;
  return index;
}

function messageFingerprint(message: Context["messages"][number]): unknown {
  const extended = message as unknown as { role: string; summary?: string };
  if (extended.role === "compactionSummary") return { role: extended.role, summary: extended.summary };
  if (message.role === "assistant") {
    return { role: message.role, provider: message.provider, model: message.model, content: message.content };
  }
  if (message.role === "toolResult") {
    return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError };
  }
  return { role: message.role, content: message.content };
}

function assistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return message.message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function sdkResultError(message: Extract<SDKMessage, { type: "result" }>): string | undefined {
  if (message.subtype === "success") return message.is_error ? message.result || "Claude Code reported an error" : undefined;
  const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.map(String).filter(Boolean) : [];
  return errors.join("\n") || `Claude Code failed: ${message.subtype}`;
}

function applyUsage(output: AssistantMessage, message: Extract<SDKMessage, { type: "result" }>): void {
  const usage = "usage" in message ? message.usage : undefined;
  if (!usage) return;
  output.usage.input = usage.input_tokens ?? 0;
  output.usage.output = usage.output_tokens ?? 0;
  output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
  output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  if ("total_cost_usd" in message && typeof message.total_cost_usd === "number") output.usage.cost.total = message.total_cost_usd;
}

function emptyAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function failStream(stream: AssistantMessageEventStream, output: AssistantMessage, message: string): void {
  output.stopReason = "error";
  output.errorMessage = message;
  stream.push({ type: "error", reason: "error", error: output });
  stream.end();
}

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A Pi turn cannot outlive its provider stream, so detached native work
 * would be killed as soon as Claude returns a result. Keep it foregrounded;
 * parallel Agent calls in one batch still execute concurrently. */
function foregroundToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (name === "Agent" || name === "Task") {
    // Remote/worktree isolation is another detached execution path and would
    // bypass both the workspace policy and this process-bound lifecycle.
    const { isolation: _isolation, ...localInput } = input;
    return { ...localInput, run_in_background: false };
  }
  if (name === "Bash" && input.run_in_background === true) return { ...input, run_in_background: false };
  return undefined;
}

function isPlanTool(name: string): boolean {
  return name === "TaskCreate" || name === "TaskGet" || name === "TaskUpdate" || name === "TaskList";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry) : [];
}

function normalizePlanStatus(value: unknown): TaskActivityItem["status"] {
  return value === "completed" ? "completed" : value === "in_progress" ? "running" : "pending";
}

function planSnapshot(registration: RegisteredSession): TaskActivityEvent {
  return {
    kind: "plan",
    tasks: [...registration.planTasks.values()].map((task) => ({
      id: task.id,
      title: task.subject,
      status: task.status,
      ...(task.blockedBy.size ? { blockedBy: [...task.blockedBy] } : {}),
    })),
  };
}

function applyPlanToolResults(
  registration: RegisteredSession,
  calls: Map<string, { name: string; input: Record<string, unknown> }>,
  message: Extract<SDKMessage, { type: "user" }>,
): void {
  const content = Array.isArray(message.message.content) ? message.message.content : [];
  const result = asArgs((message as unknown as { tool_use_result?: unknown }).tool_use_result);
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const call = calls.get(block.tool_use_id);
    if (!call) continue;
    calls.delete(block.tool_use_id);
    if (block.is_error || result.success === false) continue;

    let changed = false;
    if (call.name === "TaskList") {
      if (!Array.isArray(result.tasks)) continue;
      const listed = result.tasks;
      registration.planTasks.clear();
      for (const value of listed) {
        const task = asArgs(value);
        const id = readString(task.id);
        const subject = readString(task.subject);
        if (!id || !subject) continue;
        registration.planTasks.set(id, {
          id,
          subject,
          status: normalizePlanStatus(task.status),
          blockedBy: new Set(readStrings(task.blockedBy)),
        });
      }
      changed = true; // TaskList is the authoritative snapshot, including empty.
    } else if (call.name === "TaskCreate" || call.name === "TaskGet") {
      const task = asArgs(result.task);
      const id = readString(task.id);
      const subject = readString(task.subject) ?? readString(call.input.subject);
      if (id && subject) {
        registration.planTasks.set(id, {
          id,
          subject,
          status: normalizePlanStatus(task.status ?? call.input.status),
          blockedBy: new Set(readStrings(task.blockedBy ?? call.input.blockedBy)),
        });
        changed = true;
      }
    } else if (call.name === "TaskUpdate") {
      const id = readString(call.input.taskId) ?? readString(result.taskId);
      if (id && call.input.status === "deleted") {
        changed = registration.planTasks.delete(id);
        for (const task of registration.planTasks.values()) task.blockedBy.delete(id);
      } else if (id) {
        const task = registration.planTasks.get(id);
        if (task) {
          const subject = readString(call.input.subject);
          if (subject) task.subject = subject;
          if (typeof call.input.status === "string") task.status = normalizePlanStatus(call.input.status);
          for (const dependency of readStrings(call.input.addBlockedBy)) task.blockedBy.add(dependency);
          for (const blockedId of readStrings(call.input.addBlocks)) registration.planTasks.get(blockedId)?.blockedBy.add(id);
          changed = true;
        }
      }
    }
    if (changed) registration.onTaskActivity?.(planSnapshot(registration));
  }
}

function normalizeTaskUsage(value: unknown): TaskActivityUsage | undefined {
  const usage = asArgs(value);
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  const toolUses = typeof usage.tool_uses === "number" ? usage.tool_uses : undefined;
  const durationMs = typeof usage.duration_ms === "number" ? usage.duration_ms : undefined;
  return totalTokens !== undefined || toolUses !== undefined || durationMs !== undefined
    ? { totalTokens, toolUses, durationMs }
    : undefined;
}

function emitAgentTaskActivity(
  registration: RegisteredSession,
  hidden: Set<string>,
  message: Extract<SDKMessage, { type: "system" }>,
): void {
  if (message.subtype === "task_started") {
    // task_* also covers background Bash/monitor/workflow jobs. This surface is
    // specifically the native Agent roster; don't mislabel generic jobs.
    const isAgent = message.task_type === "local_agent" || !!message.subagent_type;
    if (message.skip_transcript || !isAgent) {
      hidden.add(message.task_id);
      return;
    }
    registration.agentTaskTitles.set(message.task_id, message.description);
    registration.onTaskActivity?.({
      kind: "agent",
      task: {
        id: message.task_id,
        title: message.description,
        status: "running",
        ...(message.task_type ? { taskType: message.task_type } : {}),
        ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
      },
    });
    return;
  }
  if (message.subtype === "task_progress") {
    if (hidden.has(message.task_id)) return;
    const title = message.description || registration.agentTaskTitles.get(message.task_id) || `Task ${message.task_id}`;
    registration.agentTaskTitles.set(message.task_id, title);
    registration.onTaskActivity?.({
      kind: "agent",
      task: {
        id: message.task_id,
        title,
        status: "running",
        ...(message.summary ? { summary: message.summary } : {}),
        ...(message.last_tool_name ? { lastToolName: cleanToolName(message.last_tool_name) } : {}),
        ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
        ...(normalizeTaskUsage(message.usage) ? { usage: normalizeTaskUsage(message.usage) } : {}),
      },
    });
    return;
  }
  if (message.subtype === "task_notification") {
    if (message.skip_transcript || hidden.delete(message.task_id)) return;
    const title = registration.agentTaskTitles.get(message.task_id) || message.summary || `Task ${message.task_id}`;
    registration.agentTaskTitles.delete(message.task_id);
    registration.onTaskActivity?.({
      kind: "agent",
      task: {
        id: message.task_id,
        title,
        status: message.status,
        ...(message.summary ? { summary: message.summary } : {}),
        ...(normalizeTaskUsage(message.usage) ? { usage: normalizeTaskUsage(message.usage) } : {}),
      },
    });
  }
}

/** Do not hand Telegram/provider tokens from Eleven's daemon environment to
 * the child. Claude's local login lives under HOME/CLAUDE_CONFIG_DIR. */
function claudeChildEnv(): Record<string, string | undefined> {
  const keys = [
    "HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "TZ", "TERM",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  return {
    ...Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "eleven",
  };
}

export function cleanToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

export interface ClaudeAuthProbe {
  ok: boolean;
  detail?: string;
}

let authCache: { value: ClaudeAuthProbe; at: number } | undefined;
const AUTH_CACHE_MS = 60_000;

/** Read the same subscription windows as Claude Code's /usage dialog without
 * issuing a model request. The SDK marks the shape experimental, so the caller
 * intentionally consumes only its small stable-looking rate-limit subset. */
export async function fetchClaudeCodeRateLimits(): Promise<SDKControlGetUsageResponse> {
  const abort = new AbortController();
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> { await parked; }
  const sdk = sdkQuery({
    prompt: noPrompt(),
    options: {
      cwd: process.cwd(), tools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: [], skills: [], plugins: [], persistSession: false,
      abortController: abort,
      env: claudeChildEnv(),
      stderr: () => {},
    },
  });
  const timeout = setTimeout(() => abort.abort(), 15_000);
  timeout.unref();
  const timed = <T>(promise: Promise<T>) => Promise.race([
    promise,
    new Promise<never>((_, reject) => abort.signal.addEventListener(
      "abort", () => reject(new Error("Claude Code usage lookup timed out")), { once: true },
    )),
  ]);
  try {
    await timed(sdk.initializationResult());
    return await timed(sdk.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET());
  } finally {
    clearTimeout(timeout);
    release();
    abort.abort();
    try { sdk.close(); } catch { /* already closed */ }
  }
}

/** Initialize the bundled official runtime without sending a model prompt. */
export async function probeClaudeCodeAuth(queryFn: typeof sdkQuery = sdkQuery): Promise<ClaudeAuthProbe> {
  if (queryFn === sdkQuery && authCache && Date.now() - authCache.at < AUTH_CACHE_MS) return authCache.value;
  const abort = new AbortController();
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> { await parked; }
  const sdk = queryFn({
    prompt: noPrompt(),
    options: {
      cwd: process.cwd(),
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: false,
      abortController: abort,
      env: claudeChildEnv(),
      stderr: () => {},
    },
  });
  let value: ClaudeAuthProbe;
  const timeout = setTimeout(() => abort.abort(), 15_000);
  timeout.unref();
  try {
    const init = await Promise.race([
      sdk.initializationResult(),
      new Promise<never>((_, reject) => abort.signal.addEventListener(
        "abort",
        () => reject(new Error("Claude Code initialization timed out")),
        { once: true },
      )),
    ]);
    const account = init.account;
    const ambientProvider = account?.apiProvider && account.apiProvider !== "firstParty";
    const authenticated = !!(ambientProvider || account?.email || account?.subscriptionType || account?.tokenSource || account?.apiKeySource);
    value = { ok: authenticated, detail: account?.subscriptionType || account?.apiProvider };
  } catch (error) {
    value = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    release();
    abort.abort();
    try { sdk.close(); } catch { /* already closed */ }
  }
  if (queryFn === sdkQuery) authCache = { value, at: Date.now() };
  return value;
}

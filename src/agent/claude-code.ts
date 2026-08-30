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
  type ImageContent,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TextContent,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BUILTIN_TOOLS, type WorkspaceTool } from "../config.ts";
import { contentText } from "../util.ts";
import { logger } from "../log.ts";
import { claudeSessionState } from "./claude-session-state.ts";
import { readToolActivity, type TaskActivityEvent, type TaskActivityUsage } from "./task-activity.ts";

const log = logger("claude-code");

export const CLAUDE_CODE_PROVIDER = "claude-code";
const MCP_SERVER = "eleven";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** Workspace capability -> Claude Code native tools.
 *
 * TaskOutput and TaskStop are deliberately absent: both only address tasks
 * running in the background, and foregroundToolInput strips run_in_background
 * from every Agent and Bash call, so no such task can exist here. */
const POLICY_TO_NATIVE: Record<WorkspaceTool, readonly string[]> = {
  read: ["Read", "Glob", "Grep"],
  bash: ["Bash"],
  edit: ["Edit"],
  write: ["Write"],
  web: ["WebFetch", "WebSearch"],
  // Nothing native. Delegation is the `workflow` tool and the plan is
  // task-tools.ts — both eleven's, both on every provider. The natives were a
  // second surface for the same two jobs, available on exactly one provider:
  // the model had to choose, the two reported differently, and eleven had to
  // neuter the Agent tool anyway (foregroundToolInput strips run_in_background
  // and isolation, because a Pi turn cannot outlive its provider stream).
  //
  // The capability itself stays: it is what gates eleven's plan tools. Putting
  // the natives back is this line — the normalizer that renders their roster
  // (emitAgentTaskActivity) is still here and still tested.
  agent: [],
};

/** Claude Code capabilities intentionally enabled when a workspace omits a
 * policy. This is an allowlist, not a denylist: new Claude tools never appear
 * in eleven by surprise. Product/cloud tools (cron, notifications, worktrees,
 * DesignSync, Workflow, etc.) stay out.
 *
 * Derived from POLICY_TO_NATIVE so the unrestricted default and the per-policy
 * expansion can never drift apart. */
const DEFAULT_NATIVE_TOOLS: readonly string[] = BUILTIN_TOOLS.flatMap((name) => POLICY_TO_NATIVE[name]);

// Claude Code settles a result for every turn its loop runs, including turns it
// never sent to a model: a resume that finds background jobs orphaned by the
// previous process injects its report ahead of the queue with shouldQuery=false,
// and answers it with a zero-turn result while this turn's prompt still waits.
// Taking that as the answer reports an empty response and closes the stream
// before the real turn starts, so skip a few and keep reading.
const MAX_NOOP_RESULT_SKIPS = 3;
// If the real turn never follows a skipped result, stop waiting on the child.
const NOOP_RESULT_GRACE_MS = 60_000;
// Such a turn does not always settle with empty prose: the CLI fills it with a
// synthetic placeholder of its own. These are constants in the Claude Code
// binary, sitting next to "<synthetic>", and neither is ever something a model
// said. Recognizing only emptiness let them through, so eleven answered the
// user with the literal string and closed the stream on a prompt still queued.
const SYNTHETIC_RESULT_TEXT = new Set(["No response requested.", "(no content)"]);

/** Overrides CLAUDE_CODE_RESUME_PROMPT for sessions eleven resumes (see claudeChildEnv). */
export const RESUME_PROMPT =
  "[This session was resumed after its previous turn was cut off. Your output is delivered as a chat message,"
  + " so ending the turn silently reads to the user as being ignored: if you had already finished a reply that"
  + " never went out, send it again — otherwise carry on and answer. No need to mention the interruption unless"
  + " it changes your answer.]";

// How long a stop waits for the CLI to acknowledge the interrupt before the
// transport is killed anyway. A stop must never hang on a child that stopped
// listening, and it must never be so eager that the child gets no chance.
const INTERRUPT_DEADLINE_MS = 2_000;

/** True when `text` carries something a model actually produced. */
function hasModelProse(text: string | undefined): boolean {
  const trimmed = text?.trim();
  return !!trimmed && !SYNTHETIC_RESULT_TEXT.has(trimmed);
}

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
  agentTaskTitles: Map<string, string>;
  /** The open input stream of a live turn, while one is running. */
  live?: InputQueue;
}

/**
 * The SDK input stream of one live turn. It stays open for the whole turn (MCP
 * needs it), which also makes it the only way to hand Claude Code human input
 * mid-loop: Claude runs its entire tool loop inside a single Pi turn, so Pi's
 * own boundary injection would park a steered message until the loop ends —
 * minutes, in a real investigation.
 */
class InputQueue {
  private readonly buffer: SDKUserMessage[] = [];
  private waiting: ((message: SDKUserMessage | undefined) => void) | undefined;
  private open = true;
  private accepted = false;

  /** Whether a live follow-up was handed to the child during this turn. Claude
   * may queue it behind the seed's own answer, so its result can arrive after. */
  get steered(): boolean {
    return this.accepted;
  }

  /** The message this turn was created for; it answers the caller's own prompt. */
  seed(message: SDKUserMessage): void {
    this.buffer.push(message);
  }

  /**
   * Queue one human follow-up, then close input. The Agent SDK folds every
   * queued message into one query and withholds its single final result until
   * this iterable reaches EOF; leaving it open for another steer deadlocks both
   * sides. Later messages return false and fall back to Pi's own steering.
   */
  push(message: SDKUserMessage): boolean {
    if (!this.open) return false;
    this.open = false;
    this.accepted = true;
    const resume = this.waiting;
    this.waiting = undefined;
    if (resume) resume(message);
    else this.buffer.push(message);
    return true;
  }

  /** Stop accepting input without ending the stream (the turn is wrapping up). */
  seal(): void {
    this.open = false;
  }

  close(): void {
    this.seal();
    this.waiting?.(undefined);
    this.waiting = undefined;
  }

  async *drain(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const queued = this.buffer.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (!this.open) return;
      const next = await new Promise<SDKUserMessage | undefined>((resolve) => (this.waiting = resolve));
      if (!next) return;
      yield next;
    }
  }
}

const sessions = new Map<string, RegisteredSession>();
const activeOwner = new AsyncLocalStorage<string>();

export function registerClaudeSession(sessionId: string, registration: ClaudeSessionRegistration): void {
  sessions.set(sessionId, { ...registration, agentTaskTitles: new Map() });
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

/**
 * Deliver human input into a session's live turn, so Claude sees it between two
 * tool calls instead of after the whole loop. False when no turn of this session
 * is reading input — the caller falls back to Pi's own steering.
 *
 * The message enters Claude's hidden transcript but never Pi's: the caller owns
 * recording it (and rebuilding the Pi session afterwards, so the next turn's
 * context has it).
 */
export function steerClaudeSession(sessionId: string, text: string, images?: ImageContent[]): boolean {
  const live = sessions.get(sessionId)?.live;
  if (!live) return false;
  return live.push(humanMessage(userBlocks(text, images)));
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

// The provider serves both `stream()` and `streamSimple()` from this one
// implementation. `stream()` hands us the per-API options union, whose
// `toolChoice` is wider than the provider-neutral one — and we ignore tool
// choice entirely, so drop the field instead of narrowing the caller.
type ClaudeCodeStreamOptions = Omit<SimpleStreamOptions, "toolChoice">;

function streamClaudeCode(
  deps: ClaudeProviderDeps,
  model: Model<Api>,
  context: Context,
  options?: ClaudeCodeStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void consumeClaudeQuery(deps, model, context, options, stream);
  return stream;
}

async function consumeClaudeQuery(
  deps: ClaudeProviderDeps,
  model: Model<Api>,
  context: Context,
  options: ClaudeCodeStreamOptions | undefined,
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
  /**
   * Stop the turn. Killing the transport outright is what eleven used to do,
   * and it leaves the child holding whatever it was running: the next resume
   * inherits those background jobs and reports them as orphans, which is the
   * wedge MAX_NOOP_RESULT_SKIPS exists to absorb. Ask the CLI to stop first and
   * let it tear its own work down — then abort regardless, on a deadline, so a
   * child that stopped listening can never make /stop hang.
   */
  const onAbort = () => {
    const query = sdk;
    if (!query) return abortController.abort();
    const deadline = setTimeout(() => abortController.abort(), INTERRUPT_DEADLINE_MS);
    deadline.unref();
    void query
      .interrupt()
      .then(
        (receipt) => {
          // Async user messages that outlive the interrupt and WILL still run.
          // Query.interrupt() takes no cancel_queued flag in this SDK, so eleven
          // cannot ask for them to be dropped — report it rather than let a
          // stopped conversation answer again out of nowhere.
          const queued = receipt?.still_queued ?? [];
          if (queued.length) log.warn(`stop left ${queued.length} queued message(s) that will still run: ${queued.join(", ")}`);
        },
        (error) => log.warn(`interrupt failed, falling back to a hard abort: ${error}`),
      )
      .finally(() => {
        clearTimeout(deadline);
        abortController.abort();
      });
  };
  if (options?.signal?.aborted) onAbort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });

  let inputDone: (() => void) | undefined;
  let live: InputQueue | undefined;
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

    const input = new InputQueue();
    live = input;
    input.seed(humanMessage(promptBlocks(context, currentStart, bootstrap)));
    inputDone = () => input.close();
    // Steering targets the owning session, never a compaction/subagent call.
    if (!isolated) registration.live = input;
    const prompt = input.drain();
    let result: SDKMessage | undefined;
    let lastTopLevelText = "";
    // One Pi turn can settle several SDK results (a steered message answered in
    // a turn of its own); every answer they carry belongs to this Pi message.
    const answers: string[] = [];
    let steerSettled = false;

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

    let skippedResult: SDKMessage | undefined;
    let noopSkips = 0;
    let grace: NodeJS.Timeout | undefined;
    sdk = deps.query({ prompt, options: sdkOptions });
    for await (const message of sdk) {
      // The child is alive and talking — a skipped result was indeed not the end.
      if (grace) { clearTimeout(grace); grace = undefined; }
      if (message.type === "assistant") {
        if (message.parent_tool_use_id === null) lastTopLevelText = assistantText(message);
        for (const block of message.message.content) {
          if (block.type !== "tool_use") continue;
          markTool(block.name, asArgs(block.input), block.id);
        }
      } else if (message.type === "system") {
        if (!isolated) emitAgentTaskActivity(registration, message);
      } else if (message.type === "result") {
        // A turn that queried no model and produced no prose answered someone
        // else's injected message, not this prompt (see MAX_NOOP_RESULT_SKIPS).
        if (
          message.subtype === "success" && message.num_turns === 0
          && !hasModelProse(message.result) && !hasModelProse(lastTopLevelText)
          && noopSkips++ < MAX_NOOP_RESULT_SKIPS
        ) {
          log.info(`ignoring a ${message.origin?.kind ?? "zero-turn"} result: this turn's prompt is still queued`);
          skippedResult = message;
          grace = setTimeout(() => abortController.abort(), NOOP_RESULT_GRACE_MS);
          grace.unref();
          continue;
        }
        result = message;
        if (sdkResultError(message)) {
          input.seal();
          break;
        }
        applyUsage(output, message);
        const settled = message.subtype === "success" ? message.result || lastTopLevelText : lastTopLevelText;
        if (hasModelProse(settled)) answers.push(settled.trim());
        lastTopLevelText = "";
        // A steered message that arrived with no tool boundary left to inject it
        // at is queued behind the seed's own answer: Claude settles the seed
        // first, then dequeues the steered prompt and runs it as another turn.
        // Breaking here killed the child with that prompt already dequeued — it
        // was recorded in the transcript, looked delivered, and never ran.
        if (input.steered && !steerSettled) {
          steerSettled = true;
          log.info("a steered message is still queued — reading past the seed's result for its answer");
          continue;
        }
        // A result closes this query. With live steering, InputQueue already
        // reached EOF after accepting its one follow-up; without steering the
        // SDK can emit the seed result while input remains open, so seal here to
        // reject a push racing the provider's teardown.
        input.seal();
        break;
      }
    }
    if (grace) clearTimeout(grace);
    if (!result) {
      // The stream ended (or the grace above aborted it) without the real turn
      // ever starting — fall back to the empty result the runner knows how to
      // fail. Nothing counted its usage or prose inside the loop.
      result = skippedResult;
      if (result?.type === "result") {
        applyUsage(output, result);
        // Past the skip budget the fallback is the skipped result itself, so the
        // placeholder gets one more chance to pose as the answer here. Drop it:
        // an empty turn is what the runner knows how to fail over.
        const settled = result.subtype === "success" ? (result.result || lastTopLevelText) : lastTopLevelText;
        if (hasModelProse(settled)) answers.push(settled.trim());
      }
    }

    if (!result || result.type !== "result") throw new Error("Claude Code ended without a result");
    const error = sdkResultError(result);
    if (error) throw new Error(error);
    const text = answers.join("\n\n") || undefined;
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
    if (live && registration.live === live) registration.live = undefined;
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
          // Pi's tool loop turns onUpdate into tool_execution_update; MCP has no
          // such loop, so eleven is the one holding the callback here. Same
          // contract either way: the tool reports activity, this forwards it.
          const scope = request.requestId ?? `${tool.name}-${randomUUID()}`;
          const onUpdate = (partial: unknown) => {
            const listener = sessions.get(ownerSessionId)?.onTaskActivity;
            if (!listener) return;
            for (const activity of readToolActivity(partial, scope)) listener(activity);
          };
          // MCP callbacks cross the SDK transport boundary. Re-enter the owner
          // explicitly so extension tools that spawn nested AgentSessions
          // (workflow) inherit Claude's cwd/provider bridge.
          const result = await activeOwner.run(ownerSessionId, () =>
            tool.execute(request.requestId ?? randomUUID(), prepared, request.signal, onUpdate),
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

/** The content blocks of the turn's own prompt: the pending user input, plus a
 * transcript of everything that happened in another runtime before it. */
function promptBlocks(context: Context, currentStart: number, bootstrap: boolean): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (bootstrap && currentStart > 0) {
    blocks.push({
      type: "text",
      text: `The conversation before this turn happened in another runtime. Continue it faithfully from this transcript:\n\n${formatTranscript(context.messages.slice(0, currentStart))}`,
    });
  }
  for (const message of context.messages.slice(currentStart)) {
    if (message.role !== "user") continue; // failed-attempt assistant envelopes are not new human input
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    blocks.push(...userBlocks(content));
  }
  return blocks;
}

function userBlocks(content: string | (TextContent | ImageContent)[], images?: ImageContent[]): Array<Record<string, unknown>> {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }, ...(images ?? [])] : content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of parts) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    if (block.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    }
  }
  return blocks;
}

function humanMessage(blocks: Array<Record<string, unknown>>): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: blocks as never },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
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

/** Additive: a turn that answered steered input mid-loop settles several SDK
 * results, and the Pi message they collapse into owns the sum. */
function applyUsage(output: AssistantMessage, message: Extract<SDKMessage, { type: "result" }>): void {
  const usage = "usage" in message ? message.usage : undefined;
  if (!usage) return;
  output.usage.input += usage.input_tokens ?? 0;
  output.usage.output += usage.output_tokens ?? 0;
  output.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
  output.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  if ("total_cost_usd" in message && typeof message.total_cost_usd === "number") output.usage.cost.total += message.total_cost_usd;
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
  message: Extract<SDKMessage, { type: "system" }>,
): void {
  // Only tasks whose start this stream saw belong on the roster. Everything else
  // is a job of another kind, or one Claude Code inherited from an earlier
  // process and reported on resume ("Orphaned by a previous Claude Code process
  // exit…") — neither is an agent of this turn.
  const known = registration.agentTaskTitles;
  if (message.subtype === "task_started") {
    // task_* also covers background Bash/monitor/workflow jobs. This surface is
    // specifically the native Agent roster; don't mislabel generic jobs.
    const isAgent = message.task_type === "local_agent" || !!message.subagent_type;
    if (message.skip_transcript || !isAgent) return;
    known.set(message.task_id, message.description);
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
    if (!known.has(message.task_id)) return;
    const title = message.description || known.get(message.task_id)!;
    known.set(message.task_id, title);
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
    const title = known.get(message.task_id);
    if (message.skip_transcript || !title) return;
    known.delete(message.task_id);
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
    // Resuming a session whose turn never finished, Claude Code injects its own
    // "Continue from where you left off." — written for a terminal, where the
    // user is watching the work. Here the turn's output *is* a chat message, so
    // a resumed turn that ends quietly reads as being ignored. Say that, and
    // stop the CLI's default from colliding with eleven's own wake prompt.
    CLAUDE_CODE_RESUME_PROMPT: RESUME_PROMPT,
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

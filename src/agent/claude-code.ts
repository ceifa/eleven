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
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TextContent,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { BUILTIN_TOOLS, POLICY_TO_NATIVE, type WorkspaceTool } from "../config.ts";
import { accountDir, currentAccount } from "../accounts.ts";
import { contentText } from "../util.ts";
import { logger } from "../log.ts";
import { claudeSessionState } from "./claude-session-state.ts";
import { readToolPanels, type PanelUpdate } from "./panels.ts";

const log = logger("claude-code");

export const CLAUDE_CODE_PROVIDER = "claude-code";
const MCP_SERVER = "eleven";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

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
// How long input stays open for a steered message no result named, once the
// CLI reports nothing left in its queue (see InputQueue.settle).
const STEER_DRAIN_GRACE_MS = 15_000;
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

/** The settings layer eleven supplies itself. `settingSources: []` keeps the
 * machine's own settings files out of the child, so this is the only place a
 * setting can come from — and the CLI still reads its defaults from here.
 *
 * Empty attribution drops the `Co-Authored-By: Claude` commit trailer and the
 * "Generated with Claude Code" PR footer, both from the commit the agent writes
 * and from the Bash tool description that instructs it. Work done through
 * eleven is the user's, signed by the user's git identity; a co-author trailer
 * on it is a claim nobody here makes.
 *
 * The git instructions are the CLI's own commit and PR workflow, written for a
 * terminal session on a feature branch: commit only when asked, branch before
 * touching the default one. A workspace here says how its own repo is worked —
 * eleven's says to commit straight to main — so the built-in version is one
 * more instruction to override, in the tool description and in the session's
 * injected `git status` both. Withholding it leaves the workspace's word as
 * the only one; the agent can still run git itself. */
const CLAUDE_SETTINGS: Settings = {
  attribution: { commit: "", pr: "" },
  includeGitInstructions: false,
};

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

/** Everything about a request that Claude's prompt cache is keyed on, beyond
 * the conversation itself: a later request reads the cached prefix only if it
 * repeats these exactly. */
interface ClaudeRequestShape {
  cwd: string;
  model: string;
  systemPrompt?: string;
  nativeTools: string[];
  customTools: AgentTool[];
  reasoning?: SimpleStreamOptions["reasoning"];
  compactAt?: number;
}

function requestOptions(shape: ClaudeRequestShape, mcpServer: ReturnType<typeof buildMcpServer>): Options {
  return {
    cwd: shape.cwd,
    model: shape.model,
    systemPrompt: { type: "preset", preset: "claude_code", append: shape.systemPrompt, snapshot: false },
    tools: shape.nativeTools,
    allowedTools: [...shape.nativeTools, ...shape.customTools.map((tool) => `${MCP_PREFIX}${tool.name}`)],
    permissionMode: "dontAsk",
    mcpServers: mcpServer ? { [MCP_SERVER]: mcpServer } : {},
    strictMcpConfig: true,
    settingSources: [],
    settings: shape.compactAt ? { ...CLAUDE_SETTINGS, autoCompactWindow: shape.compactAt } : CLAUDE_SETTINGS,
    skills: [],
    plugins: [],
    ...(shape.reasoning
      ? { thinking: { type: "adaptive" as const }, effort: EFFORT[shape.reasoning] }
      : { thinking: { type: "disabled" as const } }),
    env: claudeChildEnv(),
    stderr: (line) => log.warn(line.trim()),
  };
}

export interface ClaudeSessionRegistration {
  cwd: string;
  /** Workspace policy as written in eleven.json. Undefined means the curated default. */
  workspaceTools?: WorkspaceTool[];
  /** Native tools this workspace withholds, by name — it supplies its own. */
  excludeNativeTools?: readonly string[];
  /** Claude Code's own auto-compact window; undefined keeps its tuned default. */
  compactAt?: number;
  /** Executable, request-bound tools (Telegram today), never Pi's builtin tools. */
  customTools: AgentTool[];
  /** Record native history without putting executable tool calls on Pi's stream. */
  onHistory?: (message: AssistantMessage | ToolResultMessage) => void;
}

interface RegisteredSession extends ClaudeSessionRegistration {
  onToolCall?: (name: string, args: Record<string, unknown>, nested: boolean) => void;
  onPanels?: (update: PanelUpdate) => void;
  onProse?: (text: string) => void;
  /** An answer settled while human input the child took mid-turn is still
   * waiting for its own — it answers what was asked first, and holding it until
   * the turn ends would deliver it under the reply to what came after. */
  onEarlyAnswer?: (text: string) => void;
  /** The open input stream of a live turn, while one is running. */
  live?: InputQueue;
  /** The last committed-to-be turn's request and its cache, for an idle
   * compaction to reuse (see compactClaudeSession). */
  lastTurn?: ClaudeTurn;
  /** Human input this session's child already took off the wire
   * (steerClaudeSession). It belongs in the context of every later request —
   * the conversation happened — but sending it again would ask the child to
   * answer a message it has already answered. Entries are consumed on the first
   * request that carries them. */
  runtimeDelivered: string[];
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
  /** Uuids of the messages handed to the child that no result has answered yet,
   * in the order they were handed over. */
  private readonly unanswered = new Set<string>();

  /** The message this turn was created for; it answers the caller's own prompt. */
  seed(message: SDKUserMessage): void {
    this.unanswered.add(message.uuid!);
    this.buffer.push(message);
  }

  /**
   * Queue a human follow-up — as many as arrive while the turn runs. Claude
   * folds one that lands before a tool boundary into the running turn, and runs
   * one that lands after the last boundary as a turn of its own; either way the
   * result names the messages it answered (see settle), so input can stay open
   * for the next one. False once the turn is wrapping up: the caller falls back
   * to Pi's own steering.
   */
  push(message: SDKUserMessage): boolean {
    if (!this.open) return false;
    this.unanswered.add(message.uuid!);
    const resume = this.waiting;
    this.waiting = undefined;
    if (resume) resume(message);
    else this.buffer.push(message);
    return true;
  }

  /**
   * Cross off the messages one SDK result answered; true while another message
   * still waits for a result of its own. A result carries the uuid of every
   * message its turn consumed, the ones folded in mid-loop included. One that
   * carries none (an older CLI) answers the oldest message still waiting.
   */
  settle(result: { user_message_uuid?: string; user_message_uuids?: string[] }): boolean {
    const answered = result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : []);
    if (answered.length) for (const uuid of answered) this.unanswered.delete(uuid);
    else for (const uuid of this.unanswered) { this.unanswered.delete(uuid); break; }
    return this.unanswered.size > 0;
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
  sessions.set(sessionId, { ...registration, runtimeDelivered: [] });
}

export function unregisterClaudeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Apply a model candidate's own tool allowlist and compaction window to a live
 * registration — the runner does this before prompting each candidate. */
export function setClaudeEntry(sessionId: string, tools: WorkspaceTool[] | undefined, compactAt: number | undefined): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.workspaceTools = tools;
  session.compactAt = compactAt;
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

/** Below this, re-reading a conversation after its cache expired is cheap
 * enough that compacting it would mostly lose context. Replaying a month of
 * real conversations, the ones that stay idle near 200K are the ones a
 * compaction pays back least. */
const IDLE_COMPACTION_MIN_TOKENS = 300_000;
/** Long enough before the cache expires for the compaction request to land
 * while it is still warm. */
const IDLE_COMPACTION_LEAD_MS = 2 * 60_000;

interface ClaudeTurn {
  shape: ClaudeRequestShape;
  requestedAt: number;
  /** Prompt size of the turn's last request: the conversation Claude holds. */
  contextTokens: number;
  /** Lifetime of the cache that request wrote; unknown when it wrote none. */
  cacheTtlMs?: number;
}

/** One request's footprint on the prompt cache. A request served entirely from
 * cache writes no entry and so names no lifetime, yet still refreshes the one
 * it read — which then keeps the lifetime it had. */
function requestCache(usage: RequestUsage | undefined, requestedAt: number, previousTtlMs: number | undefined): Omit<ClaudeTurn, "shape"> {
  const created = usage?.cache_creation;
  const cacheTtlMs = created?.ephemeral_1h_input_tokens ? 60 * 60_000 : created?.ephemeral_5m_input_tokens ? 5 * 60_000 : previousTtlMs;
  return {
    requestedAt,
    contextTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
    cacheTtlMs,
  };
}

/**
 * When a conversation that just finished a turn should be compacted if nobody
 * writes in it, or undefined when it should not. Coming back after Claude's
 * prompt cache expired re-reads the whole conversation at full price; compacted
 * shortly before that, the summary is written from cache and the return is
 * cheap. Small conversations and unknown lifetimes are left alone.
 */
export function claudeIdleCompactionAt(sessionId: string): number | undefined {
  const turn = sessions.get(sessionId)?.lastTurn;
  if (!turn?.cacheTtlMs || turn.contextTokens < IDLE_COMPACTION_MIN_TOKENS) return undefined;
  return turn.requestedAt + turn.cacheTtlMs - IDLE_COMPACTION_LEAD_MS;
}

/**
 * Run Claude Code's own /compact on the conversation's committed transcript and
 * make the result what the next turn resumes. The request repeats the last
 * turn's shape so it reads that turn's cache. False when there is nothing safe
 * to compact: no committed transcript, an attempt still in flight, or a CLI
 * that did not compact.
 */
export async function compactClaudeSession(sessionId: string): Promise<boolean> {
  const deps = providerDeps;
  const registration = sessions.get(sessionId);
  const turn = registration?.lastTurn;
  const state = deps.state.get(sessionId);
  const base = state?.committed;
  if (!registration || !turn || !base || state.active) return false;
  const id = randomUUID();
  const sdk = deps.query({
    prompt: "/compact",
    options: { ...requestOptions(turn.shape, buildMcpServer(turn.shape.customTools, sessionId, () => {})), persistSession: true, sessionId: id, resume: base, forkSession: true },
  });
  let compacted = false;
  try {
    for await (const message of sdk) {
      if (message.type === "system" && message.subtype === "compact_boundary") compacted = true;
      if (message.type !== "result") continue;
      const error = sdkResultError(message);
      if (error) throw new Error(error);
      break;
    }
  } catch (error) {
    log.warn(`idle compaction failed: ${error instanceof Error ? error.message : error}`);
    compacted = false;
  } finally {
    try { sdk.close(); } catch { /* already closed */ }
  }
  // Another turn may have committed while the CLI worked; its transcript wins.
  if (!compacted || deps.state.get(sessionId)?.committed !== base) {
    await deps.deleteSession(id, { dir: registration.cwd }).catch(() => {});
    return false;
  }
  registration.lastTurn = undefined;
  const stale = deps.state.commit(sessionId, id);
  await deleteTracked(deps.state, deps.deleteSession, sessionId, registration.cwd, stale);
  return true;
}

export function setClaudeToolListener(
  sessionId: string,
  listener: ((name: string, args: Record<string, unknown>, nested: boolean) => void) | undefined,
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
 * context has it). Until then it is remembered here, so a later request of the
 * same turn can carry it in its context without handing it to the child twice.
 */
export function steerClaudeSession(sessionId: string, text: string, images?: ImageContent[]): boolean {
  const session = sessions.get(sessionId);
  if (!session?.live) return false;
  if (!session.live.push(humanMessage(userBlocks(text, images)))) return false;
  session.runtimeDelivered.push(text);
  return true;
}

export function setClaudePanelListener(
  sessionId: string,
  listener: ((update: PanelUpdate) => void) | undefined,
): void {
  const session = sessions.get(sessionId);
  if (session) session.onPanels = listener;
}

/**
 * Prose Claude produced mid-loop, the moment it produced it. Claude runs its
 * whole tool loop inside one Pi turn, so its narration would otherwise reach the
 * chat glued to the answer, minutes after it was written — and by then it reads
 * as a summary of what happened instead of what is about to. Only interim prose
 * comes through here: the turn's actual answer stays on the normal stream, where
 * the channel delivers it inside the turn's durable window.
 */
export function setClaudeProseListener(
  sessionId: string,
  listener: ((text: string) => void) | undefined,
): void {
  const session = sessions.get(sessionId);
  if (session) session.onProse = listener;
}

/**
 * An answer the child settled for the prompt this turn started with, while the
 * message that arrived meanwhile still has its own answer coming. Unlike prose,
 * this is a reply someone is waiting on — it goes out as an answer, not as
 * narration. Held to the end of the turn the two would reach the chat as one
 * block, the reply to what was said first sitting under the reply to what was
 * said next.
 */
export function setClaudeEarlyAnswerListener(
  sessionId: string,
  listener: ((text: string) => void) | undefined,
): void {
  const session = sessions.get(sessionId);
  if (session) session.onEarlyAnswer = listener;
}

/**
 * The native tools a policy enables, minus the ones the workspace withholds.
 *
 * A workspace that brings its own plan or its own delegation (an extension
 * tool) needs a way to say so: two tools for one job means the model picks, and
 * the two report differently. Withholding is by tool name and per workspace —
 * eleven ships the natives, and the workspace decides whether it wants them.
 */
export function nativeToolsForPolicy(policy: WorkspaceTool[] | undefined, exclude: readonly string[] = []): string[] {
  const enabled = policy === undefined ? DEFAULT_NATIVE_TOOLS : [...new Set(policy.flatMap((name) => POLICY_TO_NATIVE[name] ?? []))];
  return exclude.length ? enabled.filter((name) => !exclude.includes(name)) : [...enabled];
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
/** The registered provider's, so a compaction outside any turn talks to the same Claude. */
let providerDeps = defaultDeps;

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
  providerDeps = deps;
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
  context: TranscriptContext,
  options?: ClaudeCodeStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void consumeClaudeQuery(deps, model, context, options, stream);
  return stream;
}

async function consumeClaudeQuery(
  deps: ClaudeProviderDeps,
  model: Model<Api>,
  context: TranscriptContext,
  options: ClaudeCodeStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const output = emptyAssistant(model);
  stream.push({ type: "start", partial: output });

  // Pi carries the prompt and the tool declarations in the transcript's system
  // messages. Everything else here — resume ids, input hashes, the bootstrap
  // transcript — keys on the conversation alone, as it did before those
  // messages joined it, so lineages recorded then still resume.
  const systemPrompt = getCurrentSystemPrompt(context.messages) || undefined;
  const toolNames = getCurrentTools(context.messages).map((tool) => tool.name);
  const messages = context.messages.filter((message) => message.role !== "system");

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
  // Requests already recorded on a history message; the answer keeps the rest of the result's sum.
  const charged = emptyAssistant(model).usage;

  try {
    let currentStart = trailingUserStart(messages);
    if (currentStart === messages.length) throw new Error("Claude Code provider received no user message");

    const persisted = isolated ? undefined : deps.state.get(ownerSessionId);
    const active = persisted?.active;
    let baseId: string | undefined;
    let bootstrap = true;
    let recovering = false;

    if (active) {
      const prefix = messages.slice(0, active.inputCount);
      const prefixMatches = prefix.length === active.inputCount && claudeInputHash(prefix) === active.inputHash;
      // A prior subprocess died after accepting this input. Its hidden Claude
      // transcript is the side-effect authority even if Pi lost its deferred
      // first-turn file or compacted its visible prefix meanwhile. Resume it
      // and send only input that arrived after the crash; never replay the old
      // user request from a reconstructed Pi transcript.
      baseId = active.id;
      currentStart = prefixMatches ? active.inputCount : trailingUserStart(messages);
      bootstrap = false;
      recovering = true;
    }

    if (!baseId && !isolated) {
      const history = messages.slice(0, currentStart);
      const previous = history.at(-1);
      const canResume = previous?.role === "assistant"
        && previous.provider === CLAUDE_CODE_PROVIDER
        && previous.stopReason === "stop";
      if (canResume) {
        baseId = persisted?.committed ?? claudeAttemptId(ownerSessionId, previous.model, history.slice(0, -1));
        bootstrap = false;
      }
    }

    attemptId = claudeAttemptId(isolated ? requestSessionId : ownerSessionId, model.id, messages);
    if (attemptId === baseId) attemptId = randomUUID();
    if (!recovering) {
      try {
        await deps.deleteSession(attemptId, { dir: registration.cwd });
      } catch {
        // Never append into a stale deterministic fork whose deletion failed.
        attemptId = randomUUID();
      }
    }

    const historyCalls = new Map<string, string>();
    const historyResults = new Set<string>();
    const chargedRequests = new Set<string>();
    const seenToolCalls = new Set<string>();
    const seenToolSignatures = new Set<string>();
    const markTool = (name: string, args: Record<string, unknown>, id?: string) => {
      const cleanName = cleanToolName(name);
      const signature = `${cleanName}\0${JSON.stringify(args)}`;
      if ((id && seenToolCalls.has(id)) || seenToolSignatures.has(signature)) return;
      if (id) seenToolCalls.add(id);
      seenToolSignatures.add(signature);
      if (!isolated) deps.state.markTool(ownerSessionId);
      registration.onToolCall?.(cleanName, args, isolated);
    };

    const activeCustomNames = new Set(toolNames);
    const customTools = isolated ? [] : registration.customTools.filter((tool) => activeCustomNames.has(tool.name));
    // Standalone calls are either Pi compaction (no tools) or sessions an
    // extension spawned inside a tool call, which get the native read tools
    // when they declared pi's. They share the owner's cwd through
    // AsyncLocalStorage but never its side-effectful MCP tools or session state.
    const nativeTools = isolated
      ? nativeToolsForNestedContext(toolNames)
      : nativeToolsForPolicy(registration.workspaceTools, registration.excludeNativeTools);
    const mcpServer = buildMcpServer(customTools, ownerSessionId, markTool);
    const qualifiedTools = customTools.map((tool) => `${MCP_PREFIX}${tool.name}`);
    const shape: ClaudeRequestShape = {
      cwd: registration.cwd, model: model.id, systemPrompt, nativeTools, customTools,
      reasoning: options?.reasoning, compactAt: isolated ? undefined : registration.compactAt,
    };
    // When the request now being written was sent, as near as the stream shows:
    // the prompt cache lives from then.
    let requestedAt = Date.now();
    let lastRequest: Omit<ClaudeTurn, "shape"> | undefined;

    if (!isolated) {
      deps.state.begin(ownerSessionId, registration.cwd, {
        id: attemptId,
        inputHash: claudeInputHash(messages),
        inputCount: messages.length,
      });
      stateBegan = true;
    }

    const input = new InputQueue();
    live = input;
    // A bootstrapping child has taken nothing yet, and an isolated call is a
    // different child on the owner's transcript — neither may consume the
    // owner's deliveries.
    const delivered = bootstrap || isolated ? [] : registration.runtimeDelivered;
    input.seed(humanMessage(promptBlocks(messages, currentStart, bootstrap, delivered)));
    inputDone = () => input.close();
    // Steering targets the owning session, never a compaction/subagent call.
    if (!isolated) registration.live = input;
    const prompt = input.drain();
    let result: SDKMessage | undefined;
    let lastTopLevelText = "";
    // One Pi turn can settle several SDK results (a steered message answered in
    // a turn of its own); every answer they carry belongs to this Pi message.
    const answers: string[] = [];
    // Interim prose already on the stream, so the result can't answer with it a
    // second time (Claude's last message may carry both prose and a tool call).
    const flushed = new Set<string>();
    /** Append one settled block of prose to this Pi message, as it happens. */
    const emit = (text: string) => {
      const content = text.trim();
      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: content });
      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex, delta: content, partial: output });
      stream.push({ type: "text_end", contentIndex, content, partial: output });
      return content;
    };

    const logicalPayload = {
      runtime: "claude-code",
      model: model.id,
      cwd: registration.cwd,
      resume: baseId,
      sessionId: attemptId,
      tools: nativeTools,
      mcpTools: qualifiedTools,
      systemPrompt,
      messages,
    };
    // Eleven's hook records this logical invocation. The Agent SDK deliberately
    // does not expose its private wire request for mutation.
    await options?.onPayload?.(logicalPayload, model);

    const sdkOptions: Options = {
      ...requestOptions(shape, mcpServer),
      persistSession: !isolated,
      sessionId: attemptId,
      ...(baseId ? { resume: baseId, forkSession: true } : {}),
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
    };

    let skippedResult: SDKMessage | undefined;
    let noopSkips = 0;
    let grace: NodeJS.Timeout | undefined;
    let drainGrace: NodeJS.Timeout | undefined;
    sdk = deps.query({ prompt, options: sdkOptions });
    for await (const message of sdk) {
      // The child is alive and talking — a skipped result was indeed not the end.
      if (grace) { clearTimeout(grace); grace = undefined; }
      if (message.type === "assistant") {
        if (message.parent_tool_use_id === null) {
          lastRequest = requestCache(message.message.usage, requestedAt, lastRequest?.cacheTtlMs);
          const calls = message.message.content.filter((block) => block.type === "tool_use" && !historyCalls.has(block.id));
          if (calls.length && !isolated && registration.onHistory) {
            const history = emptyAssistant(model);
            history.stopReason = "toolUse";
            for (const call of calls) {
              if (call.type !== "tool_use") continue;
              const name = cleanToolName(call.name);
              historyCalls.set(call.id, name);
              history.content.push({ type: "toolCall", id: call.id, name, arguments: z.record(z.string(), z.json()).parse(asArgs(call.input)) });
            }
            // The CLI repeats one response's usage on each block it splits off.
            if (!chargedRequests.has(message.message.id)) {
              chargedRequests.add(message.message.id);
              addUsage(history.usage, message.message.usage);
              addUsage(charged, message.message.usage);
            }
            registration.onHistory(history);
          }
          const text = assistantText(message);
          // Prose that arrives with tool calls is Claude saying what it is about
          // to do, never the turn's answer — ship it now instead of holding it
          // until the loop ends, and leave nothing for the result to repeat.
          const working = message.message.content.some((block) => block.type === "tool_use");
          if (working && hasModelProse(text) && !isolated) {
            flushed.add(emit(text));
            registration.onProse?.(text.trim());
            lastTopLevelText = "";
          } else {
            lastTopLevelText = text;
          }
        }
        for (const block of message.message.content) {
          if (block.type !== "tool_use") continue;
          markTool(block.name, asArgs(block.input), block.id);
        }
      } else if (message.type === "user" && message.parent_tool_use_id === null && !isolated) {
        requestedAt = Date.now();
        const content = message.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type !== "tool_result" || historyResults.has(block.tool_use_id)) continue;
          const toolName = historyCalls.get(block.tool_use_id);
          if (!toolName) continue;
          historyResults.add(block.tool_use_id);
          const result: ToolResultMessage = {
            role: "toolResult", toolCallId: block.tool_use_id, toolName,
            content: typeof block.content === "string"
              ? [{ type: "text", text: block.content }]
              : (block.content ?? []).map((part): TextContent | ImageContent => {
                  if (part.type === "text") return { type: "text", text: part.text };
                  if (part.type === "image" && part.source.type === "base64") {
                    return { type: "image", data: part.source.data, mimeType: part.source.media_type };
                  }
                  return { type: "text", text: JSON.stringify(part) };
                }),
            isError: block.is_error ?? false, timestamp: Date.now(),
          };
          registration.onHistory?.(result);
        }
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
        if (hasModelProse(settled) && !flushed.has(settled.trim())) answers.push(settled.trim());
        lastTopLevelText = "";
        // A steered message that arrived with no tool boundary left to inject it
        // at is queued behind this answer: Claude settles what it was running
        // first, then dequeues the steered prompt and runs it as another turn.
        // Breaking here killed the child with that prompt already dequeued — it
        // was recorded in the transcript, looked delivered, and never ran. One
        // folded in mid-loop is named by this very result, and waits for nothing.
        if (input.settle(message)) {
          log.info("a steered message is still queued — reading past this result for its answer");
          // The CLI says nothing else is coming, yet a message went unnamed: a
          // producer that does not echo uuids. End input rather than wait on a
          // result that may never come — whatever the child still holds runs,
          // and then the stream ends.
          if (message.queued_turn_count === 0 && !drainGrace) {
            drainGrace = setTimeout(() => input.close(), STEER_DRAIN_GRACE_MS);
            drainGrace.unref();
          }
          // What settled here answers what was said first; the message that
          // arrived meanwhile is about to get an answer of its own. Settle it as
          // its own block now and offer it to the channel: joined at the end of
          // the turn, the person reads the reply to what they said first below
          // the reply to what they said next.
          const pending = answers.splice(0).join("\n\n");
          if (pending && !isolated) {
            flushed.add(emit(pending));
            registration.onEarlyAnswer?.(pending);
          }
          continue;
        }
        // Every message handed over is answered. Seal before the first await
        // below, so a push racing this break falls back to Pi instead of being
        // queued into a stream nobody reads anymore.
        input.seal();
        break;
      }
    }
    if (grace) clearTimeout(grace);
    if (drainGrace) clearTimeout(drainGrace);
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
        if (hasModelProse(settled) && !flushed.has(settled.trim())) answers.push(settled.trim());
      }
    }

    if (!result || result.type !== "result") throw new Error("Claude Code ended without a result");
    const error = sdkResultError(result);
    if (error) throw new Error(error);
    const text = answers.join("\n\n") || undefined;
    if (text) emit(text);
    withoutCharged(output.usage, charged);
    if (!isolated) registration.lastTurn = lastRequest && { shape, ...lastRequest };
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
    withoutCharged(output.usage, charged);
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
          // contract either way: the tool publishes panels, this forwards them.
          const scope = request.requestId ?? `${tool.name}-${randomUUID()}`;
          const onUpdate = (partial: unknown) => {
            const listener = sessions.get(ownerSessionId)?.onPanels;
            if (!listener) return;
            const update = readToolPanels(partial, scope, tool.name);
            if (update) listener(update);
          };
          // MCP callbacks cross the SDK transport boundary. Re-enter the owner
          // explicitly so extension tools that spawn nested AgentSessions
          // inherit Claude's cwd/provider bridge.
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
 * transcript of everything that happened in another runtime before it.
 *
 * `delivered` is input this child already took mid-turn, which reaches the
 * context afterwards looking exactly like new input. A bootstrapping child took
 * nothing, so it is only ever consulted for a resume. */
function promptBlocks(
  messages: Context["messages"],
  currentStart: number,
  bootstrap: boolean,
  delivered: string[] = [],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (bootstrap && currentStart > 0) {
    blocks.push({
      type: "text",
      text: `The conversation before this turn happened in another runtime. Continue it faithfully from this transcript:\n\n${formatTranscript(messages.slice(0, currentStart))}`,
    });
  }
  for (const message of messages.slice(currentStart)) {
    if (message.role !== "user") continue; // failed-attempt assistant envelopes are not new human input
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    // One entry answers for one message: the same text typed twice is two
    // messages, and the second one is still waiting for an answer.
    const alreadyDelivered = delivered.indexOf(contentText(content));
    if (alreadyDelivered !== -1) {
      delivered.splice(alreadyDelivered, 1);
      continue;
    }
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
    // The key each result names its answered messages by (InputQueue.settle).
    uuid: randomUUID(),
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

type Usage = AssistantMessage["usage"];
type RequestUsage = Extract<SDKMessage, { type: "assistant" }>["message"]["usage"];

function addUsage(target: Usage, usage: RequestUsage | undefined): void {
  target.input += usage?.input_tokens ?? 0;
  target.output += usage?.output_tokens ?? 0;
  target.cacheRead += usage?.cache_read_input_tokens ?? 0;
  target.cacheWrite += usage?.cache_creation_input_tokens ?? 0;
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
}

/** Pi reads the last row as the context size, so the answer's row must be its
 * own request, not the whole loop the result sums. */
function withoutCharged(usage: Usage, charged: Usage): void {
  usage.input = Math.max(0, usage.input - charged.input);
  usage.output = Math.max(0, usage.output - charged.output);
  usage.cacheRead = Math.max(0, usage.cacheRead - charged.cacheRead);
  usage.cacheWrite = Math.max(0, usage.cacheWrite - charged.cacheWrite);
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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
 * would be killed as soon as Claude returns a result. Keep it foregrounded.
 * Delegation is not a capability eleven grants, so Bash is the only native tool
 * left that can detach. */
function foregroundToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (name === "Bash" && input.run_in_background === true) return { ...input, run_in_background: false };
  return undefined;
}

const SHELL_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/** The shell Claude Code's Bash tool will run, or undefined if there is none.
 * The CLI only runs zsh or bash: any other $SHELL (fish, nu) makes it fall back
 * to one of those, yet its Environment block still prints $SHELL verbatim, so
 * the model writes syntax for a shell that never sees it. */
export function claudeShell(shell: string | undefined, exists: (path: string) => boolean = existsSync): string | undefined {
  if (shell && /(bash|zsh)$/.test(basename(shell))) return shell;
  return ["zsh", "bash"].flatMap((name) => SHELL_DIRS.map((dir) => `${dir}/${name}`)).find(exists);
}

/** Where Claude Code keeps the machine's own login and every transcript. */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The Claude Code config dir of an account: `CLAUDE_CONFIG_DIR=<it> claude auth
 * login` signs it in. A full login rather than a `setup-token` token, because
 * that one lacks the profile scope the usage windows are read with.
 *
 * Its `projects` links to the machine's own: transcripts live there, and a
 * turn that fails over to another account resumes the hidden Claude session
 * the last one left. A dir of its own would strand them on the old account.
 */
export function claudeAccountDir(account: string, root?: string, home = claudeHome()): string {
  const dir = join(accountDir(account, root), "claude");
  const projects = join(dir, "projects");
  mkdirSync(join(home, "projects"), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = lstatSync(projects, { throwIfNoEntry: false });
  if (!existing) symlinkSync(join(home, "projects"), projects);
  else if (!existing.isSymbolicLink()) {
    throw new Error(`${projects} is a real directory, so account "${account}" cannot resume another account's sessions — remove it`);
  }
  return dir;
}

/** Do not hand Telegram/provider tokens from Eleven's daemon environment to
 * the child. Claude's local login lives under HOME/CLAUDE_CONFIG_DIR, or under
 * the account's own dir when the turn runs on one. */
function claudeChildEnv(): Record<string, string | undefined> {
  const account = currentAccount();
  const keys = [
    "HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "TZ", "TERM",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS", "CLAUDE_CONFIG_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  // Pin execution to the same shell the prompt announces, so the two cannot drift.
  const shell = claudeShell(process.env.SHELL);
  return {
    ...Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    ...(account && { CLAUDE_CONFIG_DIR: claudeAccountDir(account) }),
    ...(shell && { SHELL: shell, CLAUDE_CODE_SHELL: shell }),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // eleven forces every Bash call into the foreground anyway (see
    // foregroundToolInput): a detached job would be killed the moment Claude
    // returns a result, and there is no next terminal prompt to report it at.
    // Without this the CLI still advertises `run_in_background` — a parameter
    // whose description promises the opposite of what eleven does with it. The
    // flag removes both the parameter and its paragraph from the Bash tool, so
    // the model is not told something untrue and the turn is that much cheaper.
    // The hook stays as the backstop for a runtime that ignores the flag.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "eleven",
    // Pi's bash tool has no default timeout and caps at setTimeout's own ceiling;
    // the Agent SDK caps a requested timeout at 10 minutes, so the same command
    // that runs fine under every other model gets killed under Claude. Match pi's
    // ceiling, for the same reason pi picked it: past 2^31-1 ms a Node timer
    // overflows and fires immediately. This lifts the ceiling only — the default
    // stays short, so a hung command still needs an explicit timeout to hang long.
    BASH_MAX_TIMEOUT_MS: "2147483647",
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

/** Per account: each one is a login of its own. */
const authCache = new Map<string | undefined, { value: ClaudeAuthProbe; at: number }>();
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
  const cached = authCache.get(currentAccount());
  if (queryFn === sdkQuery && cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.value;
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
  if (queryFn === sdkQuery) authCache.set(currentAccount(), { value, at: Date.now() });
  return value;
}

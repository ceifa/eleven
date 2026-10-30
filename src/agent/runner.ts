import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  estimateTokens,
  type CompactionResult,
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, JsonObject, JsonValue, Model, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentDir, findModel, modelRef, modelRuntime } from "./pi.ts";
import {
  abandonClaudeSession,
  CLAUDE_CODE_PROVIDER,
  commitClaudeSession,
  compactClaudeSession,
  claudeIdleCompactionAt,
  registerClaudeSession,
  runWithClaudeSession,
  setClaudeEarlyAnswerListener,
  setClaudeProseListener,
  setClaudePanelListener,
  setClaudeToolListener,
  setClaudeEntry,
  steerClaudeSession,
  unregisterClaudeSession,
} from "./claude-code.ts";
import { buildSystemPrompt, type PromptConfig, type RuntimeContext } from "./system-prompt.ts";
import {
  TOOL_CALLS_ENTRY_TYPE,
  TURN_ERROR_ENTRY_TYPE,
  type RecordedToolCall,
  type ToolCallsEntryData,
  type TurnErrorEntryData,
} from "../threads/reader.ts";
import { DEFAULT_REASONING, entryKey, PI_BUILTIN_TOOLS, type ModelEntry, type WorkspaceTool } from "../config.ts";
import { runOnAccount } from "../accounts.ts";
import { activeToolNames, elevenOwnedTools } from "./tool-policy.ts";
import { contentText, keyedLane, lruTouch } from "../util.ts";
import { logger } from "../log.ts";
import { readToolPanels, type PanelUpdate } from "./panels.ts";
import { runWithPanelSink } from "./host-api.ts";

const log = logger("runner");

/** Marks where Claude Code compacted its own copy of the conversation, which Pi's transcript does not show. */
const CLAUDE_COMPACTION_ENTRY_TYPE = "eleven:claude-compaction";

// Warm sessions: keep a thread's agent session alive between turns so a
// message doesn't pay a full cold start (settings + resource discovery +
// re-reading the whole session file) every time.
const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;
const MAX_WARM_SESSIONS = 32;

/** Everything needed to reach a conversation's pi session on disk. */
export interface SessionTarget {
  /** Absolute path of the pi session file; absent when none was ever created. */
  sessionFile?: string;
  sessionDir: string;
  workspacePath: string;
}

/**
 * Open the conversation's session, creating it when the file is missing. Pi
 * defers creating a first-turn JSONL until a message exists, so a promised path
 * may not be on disk yet: preserve the UUID embedded in the filename so
 * Claude's durable active-attempt state stays reachable.
 */
function openOrCreateSession({ sessionFile, sessionDir, workspacePath }: SessionTarget): SessionManager {
  if (sessionFile && existsSync(sessionFile)) return SessionManager.open(sessionFile, sessionDir, workspacePath);
  const id = sessionFile?.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
  return SessionManager.create(workspacePath, sessionDir, id ? { id } : undefined);
}

export interface TurnRequest extends SessionTarget {
  runtime: RuntimeContext;
  /** Ordered candidates: primary first, then fallbacks — each with its own
   * reasoning level and tool allowlist. */
  models: ModelEntry[];
  /** Provider-neutral workspace capability allowlist; undefined enables the curated default. */
  tools?: WorkspaceTool[];
  /** Runtime-native tools this workspace withholds — it supplies its own. */
  excludeNativeTools?: string[];
  customTools?: ToolDefinition[];
  /** Resolved prompt for this turn (workspace system prompt + channel appends). */
  prompt?: PromptConfig;
  text: string;
  images?: ImageContent[];
  /** Discard a failed attempt before this turn starts — a manual restart runs
   * the request as if it had never been tried. */
  rewind?: TurnRewind;
  /** Whether the conversation may be compacted while it sits idle (see
   * scheduleIdleCompaction) — asked again when the time comes. Absent means never. */
  compactWhenIdle?: () => boolean;
  /** Channel delivery of the finished turn. Runs inside the thread's turn lane
   * (before onTurnEnd fires and before the next queued turn can start), so a
   * durable in-flight ledger keyed on the hooks covers the send itself. */
  deliver?: (result: TurnResult) => Promise<void>;
}

export interface TurnEvents {
  /** Streamed assistant text delta. */
  onDelta?: (delta: string) => void;
  /** A complete assistant message finished (text may be empty for tool-only messages). */
  onAssistantText?: (text: string) => void;
  /** Prose the runtime settled mid-turn, while its own tool loop kept running —
   * what the model said before going back to work, not the turn's answer. The
   * channel ships it right away; the answer still arrives through `deliver`. */
  onProse?: (text: string) => void;
  /** An answer to the message the turn started with, settled while a message
   * that arrived mid-turn is still waiting for its own. A channel that ships it
   * now keeps the two replies in the order they were asked for; one that
   * ignores this still receives both through `deliver`. */
  onEarlyAnswer?: (text: string) => void;
  /** The attempt failed and is retrying on a fallback model — its prose is abandoned. */
  onFailover?: () => void;
  /** A retryable provider error (529, stream drop) and the runtime is running the
   * same turn again. Minutes of silence otherwise indistinguishable from thinking. */
  onRetry?: (notice: RetryNotice) => void;
  /** Raw pi event passthrough (channel lifecycle handling). */
  onEvent?: (event: AgentSessionEvent) => void;
  /** Provider-neutral tool activity for the dashboard. `id` is the call's
   *  durable id — pi's toolCallId, or the id the nested-runtime record was
   *  written under — so a live row can open the same detail view (args, and
   *  the result once it lands) a persisted one does. */
  onToolCall?: (name: string, args: Record<string, unknown>, id: string) => void;
  /** A producer replaced the panels it shows (see panels.ts). */
  onPanels?: (update: PanelUpdate) => void;
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
}

/**
 * Folds one assistant message's stream into settled blocks of prose.
 *
 * A runtime that speaks more than once in a message — Claude Code, narrating
 * between its own tool calls — settles a block per text_end, and each is a unit
 * a channel can ship on its own instead of waiting for the turn to end. A
 * provider that streams nothing and only reports the text on message_end is
 * caught up by the tail below, measured against the whole message rather than
 * its last open block.
 */
export function createProseBlocks(onDelta: (delta: string) => void, onBlock: (block: string) => void) {
  let current = "";
  let settled: string[] = [];
  const endBlock = () => {
    const block = current;
    current = "";
    settled.push(block);
    onBlock(block);
  };
  return {
    startMessage() {
      current = "";
      settled = [];
    },
    delta(delta: string) {
      current += delta;
      onDelta(delta);
    },
    endBlock,
    /** `full` is the message's whole text as the provider finally reported it.
     * Returns the blocks this message settled, in order. */
    endMessage(full: string): string[] {
      // Once a block has settled, the message is already accounted for — and how
      // `full` joined those blocks is the reader's business, not a tail to
      // stream again. The catch-up is for a provider that streamed nothing.
      if (!settled.length && full.length > current.length) {
        const tail = full.slice(current.length);
        current += tail;
        onDelta(tail);
      }
      endBlock();
      return settled;
    },
  };
}

/**
 * The prose half of a session's event stream, folded into `prose`.
 *
 * A Pi-native model runs its tool loop as one assistant message per step, and
 * prose that settles in a message carrying tool calls is the model saying what
 * it is about to do — the same narration Claude Code's loop reports through its
 * prose listener. It goes to `onInterim` the moment its message ends: held to
 * the end of the turn it reaches the chat glued to the answer, minutes after it
 * was written, reading as if the work had not started yet.
 */
export function followProse(prose: ReturnType<typeof createProseBlocks>, onInterim: (text: string) => void) {
  return (event: AgentSessionEvent | AgentEvent) => {
    if (event.type === "message_start") {
      prose.startMessage();
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      prose.delta(event.assistantMessageEvent.delta);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      prose.endBlock();
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const blocks = prose.endMessage(contentText(message.content));
      if (!message.content.some((block) => block.type === "toolCall")) return;
      for (const block of blocks) if (block.trim()) onInterim(block.trim());
    }
  };
}

export interface TurnResult {
  sessionFile: string;
  /** All assistant prose produced this turn, message boundaries joined by blank lines. */
  text: string;
  model: string;
  status: "completed" | "stopped";
}

/**
 * A turn that gave up with candidates still untried. The runner never fails over
 * automatically once an attempt ran tools — a transcript rewind cannot undo a
 * Bash command, an edit or a sent message — so the untried tail is handed to the
 * channel, which can offer the person a manual failover instead of a dead end.
 */
export class TurnFailure extends Error {
  readonly failedModel: string;
  /** Plan entries after the one that stopped the turn, in order. */
  readonly remaining: ModelEntry[];
  /** The branch a restart of this turn would rewind, filled in once the failure
   * is recorded (that record is what `from` has to still point at). */
  rewind?: TurnRewind;
  /** Isolated nested calls that are display-only, unlike the owning runtime's
   * tool history. A continuation must be told about side effects it cannot see. */
  hiddenToolCalls: RecordedToolCall[] = [];

  constructor(message: string, failedModel: string, remaining: ModelEntry[]) {
    super(message);
    this.name = "TurnFailure";
    this.failedModel = failedModel;
    this.remaining = remaining;
  }
}

/**
 * Branch a failed attempt away before running its turn again: navigate back to
 * `to`, but only while the session's leaf is still `from`. Anything appended
 * since (a turn run from the dashboard, say) sits on the branch the rewind would
 * discard — leaving it alone costs a duplicated request, dropping it costs a
 * conversation.
 */
export interface TurnRewind {
  from: string;
  to: string;
}

/**
 * The error a failed turn throws: a `TurnFailure` when the plan had candidates
 * after the one that stopped it, the plain error when the plan is exhausted
 * (nothing left to offer).
 */
export function turnFailure(error: unknown, plan: ModelEntry[], stoppedAt: number): Error {
  const failure = error instanceof Error ? error : new Error(error ? String(error) : "all models failed");
  const remaining = plan.slice(stoppedAt + 1);
  const failed = plan[stoppedAt]?.model;
  if (!remaining.length || !failed) return failure;
  return new TurnFailure(failure.message, failed, remaining);
}

interface ActiveTurn {
  session: AgentSession;
  /** Writes the transcript a steered message must be recorded in. */
  sessionManager: SessionManager;
  /** Settles when the turn ends — steering races against it to detect a missed injection. */
  done: Promise<void>;
  /** Set by interrupt() so the failover loop stops instead of retrying. */
  aborted: boolean;
  /** Messages handed straight to the runtime, bypassing Pi's queue. They are in
   * the transcript and in the runtime's own history, but the live agent loop
   * runs on a context snapshot that predates them — keep them here so the rest
   * of the turn can be given them, and so the warm session's in-memory context
   * gets rebuilt once the turn ends. */
  injected: UserMessage[];
  history: AgentMessage[];
  events: TurnEvents;
}

interface WarmSession {
  session: AgentSession;
  sessionManager: SessionManager;
  /** Everything that must match for reuse (tools, prompt, paths). */
  signature: string;
  /** Custom tools compare by identity — channels keep them stable per chat. */
  customTools?: ToolDefinition[];
  /** Read by the request-log extension at call time, so it survives failover. */
  activeModel: { current: string };
  /** Set while a model switch compacts the session (see handOff). */
  handoff: { current?: Handoff };
  /** Narrow the live session to one candidate's tool allowlist and compaction window. */
  applyEntry: (entry: ModelEntry) => void;
  lastUsedAt: number;
  /** Pending compaction before Claude's prompt cache expires; keeps the session warm until it runs. */
  idleCompaction?: NodeJS.Timeout;
}

/** A candidate's effective policy: its allowlist ∩ the workspace's; undefined
 * on either side means "everything that side allows". */
function intersectTools(workspace?: WorkspaceTool[], entry?: WorkspaceTool[]): WorkspaceTool[] | undefined {
  if (!workspace) return entry;
  if (!entry) return workspace;
  return workspace.filter((tool) => entry.includes(tool));
}

type CompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]>;

/** Pi compacts once the context passes `window - reserveTokens`; widening the
 * reserve is how a candidate's `compactAt` moves that point. Claude Code keeps
 * its own context and compacts it natively, so Pi's copy is left alone there. */
export function withCompactAt(settings: CompactionSettings, model: Model<Api> | undefined, compactAt: number | undefined): CompactionSettings {
  if (!compactAt || !model || model.provider === CLAUDE_CODE_PROVIDER || compactAt >= model.contextWindow) return settings;
  return { ...settings, reserveTokens: Math.max(settings.reserveTokens, model.contextWindow - compactAt) };
}

/** Reuse demands the same tool objects — a rebuilt tool may capture stale state. */
function sameTools(a: ToolDefinition[] | undefined, b: ToolDefinition[] | undefined): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  return (a ?? []).every((tool, index) => tool === b?.[index]);
}

export interface RunnerHooks {
  /** Fired with the provider payload (a logical SDK invocation for nested runtimes). */
  onProviderRequest?: (threadId: string, model: string, payload: unknown) => void;
  /** Fired when an owning turn begins (not for steered messages), with its
   * session file — lets the gateway record it as in-flight so an interrupted
   * turn can be woken back up after a restart. */
  onTurnStart?: (threadId: string, sessionFile: string | undefined) => void;
  /** Fired when that turn settles — after its channel delivery, still inside
   * the turn lane, so begin/end pairs of consecutive turns never overlap. */
  onTurnEnd?: (threadId: string) => void;
  /** Fired when a turn gives up, once the failure is in the transcript, with
   * the file it was written to. */
  onTurnFailed?: (threadId: string, sessionFile: string | undefined, message: string) => void;
}

/**
 * Runs pi agent turns. One turn at a time per thread (a promise lane); messages
 * arriving mid-turn are steered into the live session instead of queued.
 */
export class Runner {
  private lanes = new Map<string, Promise<unknown>>();
  private active = new Map<string, ActiveTurn>();
  private warm = new Map<string, WarmSession>();
  private hooks: RunnerHooks;

  constructor(hooks: RunnerHooks = {}) {
    this.hooks = hooks;
    setInterval(() => this.evictIdleSessions(), SESSION_SWEEP_MS).unref();
  }

  /**
   * Submit a message to a thread. Returns the turn result, or undefined when the
   * message was steered into an already-running turn (that turn's caller gets
   * the combined result).
   */
  async submit(threadId: string, request: TurnRequest, events: TurnEvents = {}): Promise<TurnResult | undefined> {
    const running = this.active.get(threadId);
    if (running && (await this.steerIntoTurn(threadId, running, request))) return undefined;
    return keyedLane(this.lanes, threadId, async () => {
      try {
        // Everything the turn reaches runs inside its panel sink: pi's agent
        // loop, its extension handlers, every tool execution. That is what lets
        // a workspace extension publish panels from outside a tool call
        // (host-api.ts) and still be routed to the right conversation.
        const result = await runWithPanelSink(
          (update) => events.onPanels?.(update),
          () => this.runTurn(threadId, request, events),
        );
        // Inside the lane but outside runTurn: a delivery failure must not
        // tear down the warm session like a model failure would.
        await request.deliver?.(result);
        return result;
      } finally {
        this.hooks.onTurnEnd?.(threadId);
      }
    });
  }

  /**
   * Inject a message into a thread's live turn. True once the message provably
   * entered the turn (pi emitted its user message); false when the turn settled
   * first — then the orphaned queue entry is cleared (a warm session would
   * replay it into the next turn) and the caller runs the message as a turn of
   * its own, so a steer that loses the end-of-turn race is never dropped.
   */
  private async steerIntoTurn(threadId: string, running: ActiveTurn, request: TurnRequest): Promise<boolean> {
    log.info(`steering message into live turn of ${threadId}`);
    if (this.steerIntoRuntime(threadId, running, request)) return true;
    let commit!: () => void;
    const committed = new Promise<boolean>((resolve) => (commit = () => resolve(true)));
    const unsubscribe = running.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user" && contentText(event.message.content) === request.text) {
        commit();
      }
    });
    try {
      await running.session.steer(request.text, request.images);
      if (await Promise.race([committed, running.done.then(() => false)])) return true;
    } catch (error) {
      log.warn(`steer into ${threadId} failed: ${error}`);
    } finally {
      unsubscribe();
    }
    running.session.clearQueue();
    if (running.aborted) {
      // interrupt() means "drop pending input" (/stop, /new, thread deletion) —
      // reviving the message as a fresh turn would undo the user's stop.
      log.info(`turn of ${threadId} was interrupted — dropping the steered message`);
      return true;
    }
    log.info(`steer missed the turn of ${threadId}, running as its own turn`);
    return false;
  }

  /**
   * Hand the message to a nested runtime that is reading input right now, so it
   * lands between two tool calls instead of after the whole loop. Pi treats a
   * Claude Code turn as a single turn of its own, so its boundary injection can
   * be minutes away — long enough for the sender to conclude they were ignored.
   *
   * Pi never sees this message as input, so we record it in the transcript
   * ourselves, at the point in time it actually arrived, and hand it to the
   * three places that would otherwise never learn of it: Pi's own message state,
   * the live agent loop (through the turn's injected list — its context is a
   * snapshot taken before the message existed), and the rebuild that follows the
   * turn.
   */
  private steerIntoRuntime(threadId: string, running: ActiveTurn, request: TurnRequest): boolean {
    if (!steerClaudeSession(running.session.sessionId, request.text, request.images)) return false;
    log.info(`delivered into the live runtime turn of ${threadId}`);
    const message: UserMessage = {
      role: "user",
      content: request.images?.length ? [{ type: "text", text: request.text }, ...request.images] : request.text,
      timestamp: Date.now(),
    };
    running.injected.push(message);
    running.history.push(message);
    try {
      running.sessionManager.appendMessage(message);
      // Pi's state is what its stats read, and pi rebuilds it from the
      // transcript only when asked — a push into it would be overwritten.
      running.session.refreshContext();
    } catch (error) {
      // The runtime already has it; a transcript gap is better than a duplicate.
      log.warn(`failed to record the steered message of ${threadId}: ${error}`);
    }
    return true;
  }

  /** Whether this process is currently running a turn for the thread. */
  isRunning(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /**
   * Reserve the same per-thread lane used by model turns. A turn already in
   * progress is rejected; one arriving after this call queues behind the
   * operation instead of racing it.
   */
  async runWhenIdle<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(threadId)) throw new Error("thread has a running turn");
    return keyedLane(this.lanes, threadId, async () => {
      if (this.active.has(threadId)) throw new Error("thread has a running turn");
      return operation();
    });
  }

  /**
   * Persist prose delivered directly by an operator/channel without invoking a
   * model. Reuse the warm manager when present so its in-memory branch stays in
   * sync with the append-only session file.
   *
   * A destination that only ever receives output (a Telegram topic the agent
   * writes to but nobody replies in) never had an inbound turn, so it has no
   * session file: materialize one here instead of refusing the delivery.
   * Returns the session file actually written, for the caller to pin onto the
   * thread record.
   */
  appendOutbound(threadId: string, target: SessionTarget, modelReference: string, text: string): string {
    if (this.active.has(threadId)) throw new Error("thread has a running turn");
    const model = findModel(modelReference);
    if (!model) throw new Error(`unknown model ${modelReference}`);
    const warm = this.warm.get(threadId);
    const sessionManager = warm?.sessionManager ?? openOrCreateSession(target);
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      // Literal operator delivery never entered Claude Code's hidden session.
      // Mark it as an Eleven-authored handoff so the next Claude turn rebuilds
      // from the visible Pi transcript instead of resuming a stale fork.
      provider: model.provider === CLAUDE_CODE_PROVIDER ? "eleven" : model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    sessionManager.appendMessage(message);
    // AgentSession keeps its own context snapshot. Rebuild it next turn so the
    // operator-authored message appended above is actually visible to the model.
    if (warm) this.dropSession(threadId);
    const written = sessionManager.getSessionFile();
    if (!written) throw new Error("session is not persisted");
    return written;
  }

  /** Abort the in-flight turn of a thread, if any. */
  async interrupt(threadId: string): Promise<boolean> {
    const running = this.active.get(threadId);
    if (!running) return false;
    running.aborted = true;
    await running.session.abort();
    return true;
  }

  /**
   * Interrupt any in-flight turn and drop the thread's warm session, so its
   * files can be deleted without a live session writing them back.
   */
  async discard(threadId: string): Promise<void> {
    await this.interrupt(threadId);
    await this.lanes.get(threadId)?.catch(() => {}); // let the aborted turn settle
    this.dropSession(threadId);
  }

  private async runTurn(threadId: string, request: TurnRequest, events: TurnEvents): Promise<TurnResult> {
    // A message prepared while this thread's *first* turn was still running was
    // resolved before that turn created the session file — adopt the warm
    // session's file instead of forking a second fresh session.
    request.sessionFile ??= this.warm.get(threadId)?.sessionManager.getSessionFile() ?? undefined;
    const candidates = request.models.map((entry) => ({ entry, model: findModel(entry.model) }));
    const missing = candidates.filter((c) => !c.model).map((c) => c.entry.model);
    const models = candidates.flatMap((c) => (c.model ? [{ entry: c.entry, model: c.model }] : []));
    if (missing.length) log.warn(`unknown models skipped: ${missing.join(", ")}`);
    if (!models.length) throw new Error(`no usable model among: ${request.models.map((entry) => entry.model).join(", ")}`);

    // Credentials resolve on the candidate's own account wherever pi touches
    // them: picking the model checks auth, prompting resolves it.
    const warm = await runOnAccount(models[0].entry.account, () => this.acquireSession(threadId, request, models[0]));
    const { session, sessionManager, activeModel } = warm;
    clearTimeout(warm.idleCompaction);
    warm.idleCompaction = undefined;
    // A restart of a failed turn drops that attempt's branch first, so this turn
    // opens on the transcript the failed one started from.
    if (request.rewind && sessionManager.getLeafId() === request.rewind.from) {
      await rewindFailedAttempt(session, sessionManager, request.rewind.to);
    }
    // pi persists the user message on every prompt(), even when the provider
    // errors — so a bare re-prompt on the next candidate would duplicate it.
    // Failover branches back to this entry instead, abandoning the failed
    // attempt (session files stay append-only; only the leaf pointer moves).
    const turnStart = sessionManager.getLeafId();
    // Mark the turn in-flight now that we have a session file: if the daemon is
    // killed mid-turn, this is what a restart uses to wake the conversation.
    this.hooks.onTurnStart?.(threadId, sessionManager.getSessionFile());
    let settle!: () => void;
    const active: ActiveTurn = {
      session,
      sessionManager,
      done: new Promise((resolve) => (settle = resolve)),
      aborted: false,
      injected: [],
      history: [],
      events,
    };
    this.active.set(threadId, active);

    const collected: string[] = [];
    const prose = createProseBlocks(
      (delta) => events.onDelta?.(delta),
      (block) => {
        if (block.trim()) collected.push(block.trim());
        events.onAssistantText?.(block);
      },
    );
    // pi does not reject prompt() on a provider failure or an abort — it settles
    // the run with an empty assistant message carrying stopReason "error"/"aborted".
    // Track the last one so the failover loop can tell those apart from a genuine
    // (retry-worthy) empty response.
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let attemptHadToolActivity = false;
    // Hooks can also observe nested calls that the top-level SDK history omits.
    let claudeToolCallCount = 0;
    let hiddenToolCalls: RecordedToolCall[] = [];
    setClaudeToolListener(session.sessionId, (name, args, nested) => {
      attemptHadToolActivity = true;
      if (!nested) return;
      const call: RecordedToolCall = { id: `claude:${claudeToolCallCount++}:${Date.now()}`, name, args };
      hiddenToolCalls.push(call);
      try {
        sessionManager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [call] } satisfies ToolCallsEntryData);
      } catch (error) {
        log.warn(`failed to record tool call ${name} for ${threadId}: ${error}`);
      }
      events.onToolCall?.(name, args, call.id);
    });
    setClaudePanelListener(session.sessionId, (update) => events.onPanels?.(update));
    setClaudeProseListener(session.sessionId, (text) => events.onProse?.(text));
    setClaudeEarlyAnswerListener(session.sessionId, (text) => events.onEarlyAnswer?.(text));
    const onProseEvent = followProse(prose, (text) => events.onProse?.(text));
    const unsubscribe = session.subscribe((event) => {
      events.onEvent?.(event);
      onProseEvent(event);
      if (event.type === "auto_retry_start") {
        // Pi retries a retryable provider error under the failover loop, without
        // ever settling prompt() — so this is the only trace the turn stalled.
        log.warn(`retrying turn of ${threadId} (${event.attempt}/${event.maxAttempts}) after: ${event.errorMessage}`);
        events.onRetry?.({ attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage });
      } else if (event.type === "auto_retry_end" && !event.success) {
        log.warn(`turn of ${threadId} gave up after ${event.attempt} retries: ${event.finalError ?? "unknown error"}`);
      } else if (event.type === "tool_execution_start") {
        attemptHadToolActivity = true;
        events.onToolCall?.(event.toolName, event.args, event.toolCallId);
      } else if (event.type === "tool_execution_update") {
        // A long-running tool publishing its own panels. The payload is the
        // tool's, not eleven's: readToolPanels validates it, so nothing here
        // knows what the tool actually does.
        const update = readToolPanels(event.partialResult, event.toolCallId, event.toolName);
        if (update) events.onPanels?.(update);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        lastStopReason = message.stopReason;
        lastErrorMessage = message.errorMessage;
      }
    });

    try {
      let lastError: unknown;
      // Where the plan stopped — a break past a toolful attempt leaves the tail
      // untried, and that tail is what a manual failover would run.
      let stoppedAt = 0;
      for (const [index, { entry, model }] of models.entries()) {
        stoppedAt = index;
        attemptHadToolActivity = false;
        hiddenToolCalls = [];
        if (index > 0) {
          log.warn(`falling over to ${entryKey(entry)} for ${threadId}`);
          // A rewind drops the failed attempt's branch, and human input the
          // runtime was handed mid-attempt lives on that branch and nowhere
          // else. Re-prompting on top duplicates the request; rewinding would
          // delete something the user actually said.
          if (!active.injected.length) await rewindFailedAttempt(session, sessionManager, turnStart);
          // Prose from the abandoned attempt is off the surviving branch —
          // don't let it leak into this turn's result.
          collected.length = 0;
          events.onFailover?.();
          await runOnAccount(entry.account, () => session.setModel(model));
          // Each candidate runs with its own reasoning level and tool allowlist.
          session.setThinkingLevel(entry.reasoning ?? DEFAULT_REASONING);
          warm.applyEntry(entry);
          activeModel.current = modelRef(model);
        }
        await handOff(warm, model);
        lastStopReason = undefined;
        lastErrorMessage = undefined;
        try {
          await runOnAccount(entry.account, () =>
            runWithClaudeSession(session.sessionId, () => session.prompt(request.text, { images: request.images })));
        } catch (error) {
          lastError = error;
          log.error(`turn failed on ${modelRef(model)}: ${error}`);
          // Rewinding a transcript cannot rewind Bash, edits, Telegram sends,
          // or any other side effect. Never replay a toolful attempt.
          if (attemptHadToolActivity) break;
          continue;
        }
        // User /stop aborts the run; pi settles prompt() with
        // an empty message. Stop here — do NOT fail over, which would silently
        // re-run the whole (stopped) turn on the next model.
        if (active.aborted) break;
        // A provider error also settles as an empty message (stopReason "error"),
        // not a throw. Fail over on it and surface the real error if none succeed —
        // even when earlier prose arrived, so a truncated reply isn't sold as success.
        if (lastStopReason === "error") {
          lastError = new Error(`provider error on ${modelRef(model)}: ${lastErrorMessage ?? "unknown"}`);
          log.error(String(lastError));
          if (attemptHadToolActivity) break;
          continue;
        }
        // An error-free turn with zero prose (e.g. a provider entitlement quirk
        // returning an empty message) still counts as a failure worth failing over.
        if (collected.length || attemptHadToolActivity) {
          if (model.provider === CLAUDE_CODE_PROVIDER) {
            await commitClaudeSession(session.sessionId);
            if (request.compactWhenIdle?.()) this.scheduleIdleCompaction(threadId, warm, entry.account, request.compactWhenIdle);
          }
          warm.lastUsedAt = Date.now();
          return { sessionFile: sessionManager.getSessionFile()!, text: collected.join("\n\n"), model: modelRef(model), status: "completed" };
        }
        if (model.provider === CLAUDE_CODE_PROVIDER) await abandonClaudeSession(session.sessionId);
        lastError = new Error(`empty response from ${modelRef(model)}`);
        log.warn(String(lastError));
      }
      if (active.aborted) {
        // Stopped by the user — hand back whatever prose arrived before the stop
        // (often nothing). The session may sit mid-tool, so rebuild it next turn.
        this.dropSession(threadId);
        return { sessionFile: sessionManager.getSessionFile()!, text: collected.join("\n\n"), model: activeModel.current, status: "stopped" };
      }
      throw turnFailure(lastError, models.map(({ entry }) => entry), stoppedAt);
    } catch (error) {
      // pi persists what a provider produced, and a turn that gave up produced
      // nothing — so without this the transcript reads as if the message was
      // simply ignored. Record the failure where it happened, then tell the
      // gateway which file it landed in: a first turn that never got a reply is
      // the one case where the thread doesn't know its session file yet.
      const message = error instanceof Error ? error.message : String(error);
      let sessionFile: string | undefined;
      try {
        sessionManager.appendCustomEntry(TURN_ERROR_ENTRY_TYPE, { message } satisfies TurnErrorEntryData);
        // pi holds a session in memory until its first assistant message, so a
        // first turn that failed before any reply has no file at all — and
        // writing one here would collide with pi's own exclusive first flush.
        // getSessionFile() still hands back the path it *would* use, so check
        // the disk: pinning a thread to a file that isn't there breaks the next
        // turn's resume. In that case the toast is the only report there is.
        const file = sessionManager.getSessionFile();
        if (file && existsSync(file)) sessionFile = file;
        // The failure is now the transcript's leaf: a restart may rewind past it
        // for as long as it stays that way.
        const leaf = sessionManager.getLeafId();
        if (error instanceof TurnFailure) {
          if (leaf && turnStart) error.rewind = { from: leaf, to: turnStart };
          error.hiddenToolCalls = hiddenToolCalls;
        }
      } catch (writeError) {
        log.warn(`failed to record the failed turn of ${threadId}: ${writeError}`);
      }
      this.hooks.onTurnFailed?.(threadId, sessionFile, message);
      // A failed turn may leave the session in a dubious state — rebuild next time.
      this.dropSession(threadId);
      throw error;
    } finally {
      setClaudeToolListener(session.sessionId, undefined);
      setClaudePanelListener(session.sessionId, undefined);
      setClaudeProseListener(session.sessionId, undefined);
      setClaudeEarlyAnswerListener(session.sessionId, undefined);
      unsubscribe();
      // A message went into the runtime and the transcript but not into the
      // session's context snapshot — rebuild it so the next turn can see it.
      if (active.injected.length) this.dropSession(threadId);
      this.active.delete(threadId);
      settle();
    }
  }

  /** The thread's warm session when everything about it still matches; a fresh one otherwise. */
  private async acquireSession(
    threadId: string,
    request: TurnRequest,
    initial: { entry: ModelEntry; model: Model<Api> },
  ): Promise<WarmSession> {
    const systemPrompt = buildSystemPrompt(request.runtime, request.prompt);
    // Model candidates (and their reasoning/tool settings) are deliberately
    // absent: setModel/setThinkingLevel/applyEntry below reconcile the
    // live session, so editing the sequence never discards a warm session.
    const signature = JSON.stringify([
      request.sessionDir,
      request.workspacePath,
      request.tools,
      request.excludeNativeTools,
      systemPrompt,
    ]);

    const cached = lruTouch(this.warm, threadId);
    if (
      cached &&
      cached.signature === signature &&
      cached.sessionManager.getSessionFile() === request.sessionFile &&
      sameTools(cached.customTools, request.customTools)
    ) {
      cached.lastUsedAt = Date.now();
      // The session may still sit on last turn's fallback model (or a previous
      // config's reasoning/tool settings).
      const { session } = cached;
      if (!session.model || modelRef(session.model) !== modelRef(initial.model)) await session.setModel(initial.model);
      session.setThinkingLevel(initial.entry.reasoning ?? DEFAULT_REASONING);
      cached.applyEntry(initial.entry);
      cached.activeModel.current = modelRef(initial.model);
      return cached;
    }
    this.dropSession(threadId);

    const sessionManager = openOrCreateSession(request);

    // Mutable ref so the request-log extension tags payloads with the model
    // actually in use, even after a mid-turn failover.
    const activeModel = { current: modelRef(initial.model) };
    const handoff: WarmSession["handoff"] = {};

    const settingsManager = SettingsManager.create(request.workspacePath, agentDir);
    // Pi compacts near the window unless told otherwise; the candidate driving
    // the turn may want it much sooner (see ModelEntry.compactAt).
    const compactAt: { current?: number } = {};
    const compactionSettings = settingsManager.getCompactionSettings.bind(settingsManager);
    settingsManager.getCompactionSettings = (model) =>
      withCompactAt(compactionSettings(model), model && findModel(`${model.provider}/${model.id}`), compactAt.current);
    const loader = new DefaultResourceLoader({
      cwd: request.workspacePath,
      agentDir,
      settingsManager,
      // Extensions load as under `pi -p`: global ones, the workspace's
      // .pi/extensions, and packages from both settings files. The print-mode
      // binding below is what tells them no terminal is attached.
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: workspaceResources(request.workspacePath).skillDirs,
      systemPrompt,
      // pi's sanctioned hook points (never touch streamFn).
      extensionFactories: [{
        name: "eleven-runtime",
        factory: (pi: ExtensionAPI) => {
          pi.on("context", (event) => ({ messages: boundRuntimeResults(withToolResults(event.messages)) }));
          pi.on("session_before_compact", (event) =>
            handoff.current ? { compaction: handoffCompaction(event.preparation, handoff.current, sessionManager.getSessionFile()) } : undefined);
          if (this.hooks.onProviderRequest) {
            pi.on("before_provider_request", (event) => {
              this.hooks.onProviderRequest?.(threadId, activeModel.current, event.payload);
              return undefined;
            });
          }
        },
      }],
    });
    await loader.reload();
    const extensionToolNames = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);

    const { session } = await createAgentSession({
      cwd: request.workspacePath,
      agentDir,
      modelRuntime,
      model: initial.model,
      thinkingLevel: initial.entry.reasoning ?? DEFAULT_REASONING,
      tools: request.tools
        ? [
            ...request.tools.filter((t) => (PI_BUILTIN_TOOLS as readonly string[]).includes(t)),
            ...extensionToolNames,
            ...(request.customTools ?? []).map((tool) => tool.name),
          ]
        : undefined,
      customTools: request.customTools,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      sessionStartEvent: { type: "session_start", reason: request.sessionFile ? "resume" : "new", previousSessionFile: request.sessionFile },
    });
    // pi only dispatches session lifecycle events to extensions once a host
    // binds them — the gateway is a headless host, print-mode style.
    await session.bindExtensions({ mode: "print" });
    // A burst can steer several messages while a boundary is far away (long
    // tool call) — deliver them all at once, not one per boundary.
    session.setSteeringMode("all");

    // Extension tools are Eleven-owned capabilities
    // just like channel tools. Keep Claude builtins native, but expose every
    // Eleven-owned tool through the isolated MCP bridge with its bound executor.
    // Deriving this from the session registry instead would sweep up the pi
    // builtins pi registers but leaves inactive (powershell, grep/find/ls) and
    // switch them on.
    const customNames = elevenOwnedTools(extensionToolNames, (request.customTools ?? []).map((tool) => tool.name));
    registerClaudeSession(session.sessionId, {
      cwd: request.workspacePath,
      workspaceTools: request.tools,
      excludeNativeTools: request.excludeNativeTools,
      customTools: session.agent.state.tools.filter((tool) => customNames.includes(tool.name)),
      onHistory: (message) => {
        sessionManager.appendMessage(message);
        session.refreshContext();
        const active = this.active.get(threadId);
        active?.history.push(message);
        if (message.role === "assistant") {
          for (const block of message.content) {
            if (block.type === "toolCall") active?.events.onToolCall?.(block.name, block.arguments, block.id);
          }
        }
      },
    });
    keepRuntimeInputsInContext(session, () => this.active.get(threadId)?.history.splice(0) ?? []);

    // What pi activated on its own (its coding default: read/bash/edit/write),
    // before any policy narrows it.
    const piActive = session.getActiveToolNames();
    // Close over just this field: the closure lives as long as the warm
    // session, and capturing `request` would pin the turn's text and images.
    const workspaceTools = request.tools;
    const applyEntry = (entry: ModelEntry) => {
      const policy = intersectTools(workspaceTools, entry.tools);
      session.setActiveToolsByName(activeToolNames(piActive, customNames, policy));
      compactAt.current = entry.compactAt;
      setClaudeEntry(session.sessionId, policy, entry.compactAt);
    };
    applyEntry(initial.entry);

    const warm: WarmSession = {
      session,
      sessionManager,
      signature,
      customTools: request.customTools,
      activeModel,
      handoff,
      applyEntry,
      lastUsedAt: Date.now(),
    };
    this.warm.set(threadId, warm);
    if (this.warm.size > MAX_WARM_SESSIONS) this.evictOldestSession(threadId);
    return warm;
  }

  /** Compact the thread's Claude conversation shortly before its prompt cache
   * expires, unless another turn comes first (see claudeIdleCompactionAt).
   * Timers live in memory: a restart skips the ones still waiting. */
  private scheduleIdleCompaction(threadId: string, warm: WarmSession, account: string | undefined, allowed: () => boolean) {
    const at = claudeIdleCompactionAt(warm.session.sessionId);
    if (at === undefined) return;
    warm.idleCompaction = setTimeout(() => {
      warm.idleCompaction = undefined;
      this.runWhenIdle(threadId, async () => {
        if (this.warm.get(threadId) !== warm || !allowed()) return;
        if (!(await runOnAccount(account, () => compactClaudeSession(warm.session.sessionId)))) return;
        warm.sessionManager.appendCustomEntry(CLAUDE_COMPACTION_ENTRY_TYPE, { reason: "idle" });
        log.info(`compacted the idle Claude conversation of ${threadId} before its cache expired`);
      }).catch((error) => log.warn(`idle compaction of ${threadId} skipped: ${error}`));
    }, Math.max(0, at - Date.now()));
    warm.idleCompaction.unref();
  }

  private dropSession(threadId: string) {
    const warm = this.warm.get(threadId);
    if (!warm) return;
    clearTimeout(warm.idleCompaction);
    unregisterClaudeSession(warm.session.sessionId);
    warm.session.dispose();
    this.warm.delete(threadId);
  }

  private evictIdleSessions() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [threadId, warm] of this.warm) {
      if (warm.lastUsedAt < cutoff && !warm.idleCompaction && !this.active.has(threadId)) this.dropSession(threadId);
    }
  }

  /** The warm map is LRU-ordered (lruTouch), so the first evictable key is the oldest. */
  private evictOldestSession(except: string) {
    for (const threadId of this.warm.keys()) {
      if (threadId === except || this.active.has(threadId)) continue;
      this.dropSession(threadId);
      return;
    }
  }
}

/** Native history and directly delivered input bypass Pi's running snapshot.
 * Drain them into its next turn before preparation, so compaction sees them
 * without having the original messages reinserted after its summary. */
export function keepRuntimeInputsInContext(session: AgentSession, takeInputs: () => AgentMessage[]): void {
  const { agent } = session;
  const previous = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const messages = withRuntimeInputs(turn.context.messages, takeInputs());
    if (messages === turn.context.messages) return previous?.(turn, signal);
    const context = { ...turn.context, messages };
    const snapshot = await previous?.({ ...turn, context }, signal);
    return { ...snapshot, context: snapshot?.context ?? context };
  };
}

/**
 * A live turn's context with the input and tool history Pi's snapshot missed put back
 * where it happened: before the answer that was being written when it arrived,
 * which is where the durable transcript records it too. Messages already in the
 * context are left alone — the loop carries the array forward from one turn to
 * the next, so this runs again on its own output, and a compaction mid-turn
 * hands back the same message reloaded from the transcript as a new object.
 * Returns the original array when there is nothing to add, so pi's snapshot is
 * passed through untouched.
 */
export function withRuntimeInputs(messages: AgentMessage[], injected: AgentMessage[]): AgentMessage[] {
  const present = new Set(messages.map(runtimeInputKey));
  const missing = injected.filter((message) => !present.has(runtimeInputKey(message)));
  if (!missing.length) return messages;
  // Never between an assistant's tool calls and their results: when the turn
  // used tools, those results are the tail and the input goes after them.
  const cut = messages.length - (messages.at(-1)?.role === "assistant" ? 1 : 0);
  return [...messages.slice(0, cut), ...missing, ...messages.slice(cut)];
}

/** A message steered during a native call is recorded immediately; its result
 * must still precede that input in the model's tool protocol. */
export function withToolResults(messages: AgentMessage[]): AgentMessage[] {
  const results = new Map(messages.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
  const moved = new Set<AgentMessage>();
  const ordered: AgentMessage[] = [];
  for (const message of messages) {
    if (moved.has(message)) continue;
    ordered.push(message);
    if (message.role === "toolResult") results.delete(message.toolCallId);
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      if (!result) continue;
      ordered.push(result);
      moved.add(result);
      results.delete(block.id);
    }
  }
  return ordered.every((message, index) => message === messages[index]) ? messages : ordered;
}

const RESULT_HEAD_CHARS = 2_000;
const RESULTS_BUDGET_CHARS = 60_000;
const ANSWERED_ARGUMENT_CHARS = 300;

/** Claude Code's tool history never entered Pi's context before, and a real
 * thread's runs past a million tokens. A provider picking such a thread up gets
 * every call with short arguments and the head of the newest outputs, up to a
 * fixed budget — not all of it cold. Turns still unanswered keep everything a
 * continuation needs. */
export function boundRuntimeResults(messages: AgentMessage[]): AgentMessage[] {
  const answered = messages.findLastIndex((message) => message.role === "assistant" && message.stopReason === "stop");
  const runtimeCalls = new Set(messages.slice(0, answered).flatMap((message) =>
    message.role === "assistant" && message.provider === CLAUDE_CODE_PROVIDER
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : []));
  if (!runtimeCalls.size) return messages;
  // Newest first, and once one does not fit nothing older does: the window stays contiguous.
  const kept = new Set<number>();
  let budget = RESULTS_BUDGET_CHARS;
  for (let index = answered - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult" || !runtimeCalls.has(message.toolCallId)) continue;
    const size = Math.min(contentText(message.content).length, RESULT_HEAD_CHARS);
    if (size > budget) break;
    budget -= size;
    kept.add(index);
  }
  return messages.map((message, index) => {
    if (index > answered) return message;
    if (message.role === "assistant") {
      if (message.provider !== CLAUDE_CODE_PROVIDER) return message;
      const content = message.content.map((block) => block.type === "toolCall" ? { ...block, arguments: shortenStrings(block.arguments) as JsonObject } : block);
      return JSON.stringify(content) === JSON.stringify(message.content) ? message : { ...message, content };
    }
    if (message.role !== "toolResult" || !runtimeCalls.has(message.toolCallId)) return message;
    const text = contentText(message.content);
    const images = message.content.some((block) => block.type === "image");
    if (!kept.has(index)) {
      return { ...message, content: [{ type: "text", text: `[older output omitted for context (${text.length.toLocaleString("en-US")} characters). Run the tool again if you need it.]` }] };
    }
    if (text.length <= RESULT_HEAD_CHARS && !images) return message;
    const shown = Math.min(text.length, RESULT_HEAD_CHARS).toLocaleString("en-US");
    const notice = `[output shortened for context: ${shown} of ${text.length.toLocaleString("en-US")} characters${images ? ", images omitted" : ""}. Run the tool again if you need the rest.]`;
    return { ...message, content: [{ type: "text", text: `${text.slice(0, RESULT_HEAD_CHARS)}\n${notice}` }] };
  });
}

function shortenStrings(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.length > ANSWERED_ARGUMENT_CHARS ? `${value.slice(0, ANSWERED_ARGUMENT_CHARS)}… [${value.length.toLocaleString("en-US")} characters]` : value;
  }
  if (Array.isArray(value)) return value.map(shortenStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenStrings(item)]));
  return value;
}

/** Below this a model switch carries the conversation whole: re-reading it
 * uncached costs less than what cutting it would lose. */
const HANDOFF_MIN_TOKENS = 100_000;
const HANDOFF_REQUEST_CHARS = 4_000;

interface Handoff {
  from: string;
  to: string;
}

/**
 * A model that takes over a long conversation has none of it cached, so every
 * request it makes re-reads all of it at full price — and a fallback tends to
 * take over exactly when a long task drained the model before it. Hand it the
 * recent part instead: a compaction that keeps Pi's recent window and replaces
 * the rest with a pointer to the transcript, written here rather than by a model
 * that would have to read everything to summarize it.
 */
export async function handOff(warm: Pick<WarmSession, "session" | "handoff">, model: Model<Api>): Promise<void> {
  const { session } = warm;
  const from = lastModelThatRan(session.agent.state.messages);
  const to = modelRef(model);
  if (!from || from === to) return;
  const tokens = session.getContextUsage()?.tokens ?? session.agent.state.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (tokens < HANDOFF_MIN_TOKENS) return;
  warm.handoff.current = { from, to };
  try {
    await session.compact();
    log.info(`handed ${to} the recent part of a ${tokens}-token conversation from ${from}`);
  } catch (error) {
    log.warn(`handoff from ${from} to ${to} kept the whole conversation: ${error}`);
  } finally {
    warm.handoff.current = undefined;
  }
}

/** The model behind the latest response that cost anything — operator-written
 * messages are recorded as assistant turns too, with no usage. */
function lastModelThatRan(messages: AgentMessage[]): string | undefined {
  const last = messages.findLast((message) => message.role === "assistant" && message.usage.totalTokens > 0);
  return last?.role === "assistant" ? `${last.provider}/${last.model}` : undefined;
}

/** The compaction a handoff writes: Pi's cut point, and in place of a summary,
 * where the rest is and the requests the cut would otherwise hide. */
export function handoffCompaction(
  preparation: SessionBeforeCompactEvent["preparation"],
  { from, to }: Handoff,
  sessionFile: string | undefined,
): CompactionResult {
  const firstRequest = preparation.messagesToSummarize.find((message) => message.role === "user");
  const currentRequest = preparation.isSplitTurn ? preparation.turnPrefixMessages.find((message) => message.role === "user") : undefined;
  const quote = (message: AgentMessage) => {
    const text = message.role === "user" ? contentText(message.content) : "";
    return text.length > HANDOFF_REQUEST_CHARS ? `${text.slice(0, HANDOFF_REQUEST_CHARS)}… [${text.length.toLocaleString("en-US")} characters]` : text;
  };
  const sections = [
    `This conversation moved from ${from} to ${to}, which has none of it cached, so only its most recent part follows.`
      + (sessionFile ? ` The full transcript is ${sessionFile} (a Pi session, one JSON entry per line): read what you need from it instead of guessing.` : ""),
    preparation.previousSummary && `Summary from an earlier compaction:\n${preparation.previousSummary}`,
    firstRequest && `The earliest request in the omitted part, verbatim:\n${quote(firstRequest)}`,
    currentRequest && `The request being worked on when the cut was made, verbatim:\n${quote(currentRequest)}`,
  ];
  return {
    summary: sections.filter(Boolean).join("\n\n"),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { handoff: { from, to } },
  };
}

/** Identifies one message across a transcript round-trip: the arrival instant
 * plus what was said. Two messages of the same turn never share both. */
function runtimeInputKey(message: AgentMessage): string {
  const timestamp = (message as { timestamp?: number }).timestamp ?? 0;
  const callId = message.role === "toolResult" ? message.toolCallId : "";
  return `${message.role}\0${timestamp}\0${callId}\0${JSON.stringify((message as { content?: unknown }).content)}`;
}

/**
 * Branch the session back to the turn's starting entry so a failover retry
 * doesn't append a second copy of the user message. navigateTree also rebuilds
 * the agent's in-memory context from the surviving path. Best-effort: when the
 * starting leaf isn't a safe branch target, the retry re-prompts on top (the
 * pre-rewind behavior, duplicate and all) rather than failing the turn.
 */
async function rewindFailedAttempt(
  session: AgentSession,
  sessionManager: SessionManager,
  turnStart: string | null,
): Promise<void> {
  if (!turnStart || sessionManager.getLeafId() === turnStart) return;
  const entry = sessionManager.getEntry(turnStart);
  // navigateTree treats user/custom messages as an edit — it moves the leaf
  // *above* them, which would drop a real message from the conversation.
  if (!entry || entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user")) return;
  try {
    await session.navigateTree(turnStart);
  } catch (error) {
    log.warn(`rewind of failed attempt did not apply: ${error}`);
  }
}

/** The skills a turn in this workspace would load — same discovery as runTurn. */
export async function listWorkspaceSkills(workspacePath: string): Promise<{ name: string; description: string }[]> {
  const loader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager: SettingsManager.create(workspacePath, agentDir),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: workspaceResources(workspacePath).skillDirs,
  });
  await loader.reload();
  return loader
    .getSkills()
    .skills.map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface WorkspaceResources {
  /** Nested `.agents/skills` dirs — pi only discovers cwd + ancestors. */
  skillDirs: string[];
}

const resourceCache = new Map<string, { resources: WorkspaceResources; at: number }>();
const RESOURCE_CACHE_MS = 60_000;

/**
 * pi discovers `.agents/skills` only in cwd and its ancestors. Monorepo
 * workspaces keep skill packs in nested context directories — surface them.
 * (Nested AGENTS.md are the agent's own job: the workspace's root AGENTS.md
 * instructs it to read the closest one before working in a context.)
 * The walk is sync and sits on the message hot path, so results are cached.
 */
function workspaceResources(root: string, depth = 3): WorkspaceResources {
  const cached = resourceCache.get(root);
  if (cached && Date.now() - cached.at < RESOURCE_CACHE_MS) return cached.resources;
  const resources: WorkspaceResources = { skillDirs: [] };
  const walk = (dir: string, level: number) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // A directory we cannot enumerate drops every skill pack beneath it, and
      // the result is cached — so the loss outlives the fault while `/skills`
      // just looks short. Say so instead of pretending the subtree is empty.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`skill scan: cannot enumerate ${dir} — skills below it are missing: ${error}`);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(child))) continue;
      const skills = join(child, ".agents", "skills");
      if (existsSync(skills)) resources.skillDirs.push(skills);
      walk(child, level + 1);
    }
  };
  walk(root, 1);
  resourceCache.set(root, { resources, at: Date.now() });
  return resources;
}

/** Follows symlinks; stat is far cheaper than listing the directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A workspace can ship pi extensions (pi's own project convention). pi wants
 * entry-point files here, not the directory. */

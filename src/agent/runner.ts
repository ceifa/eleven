import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentDir, findModel, modelRef, modelRuntime } from "./pi.ts";
import {
  abandonClaudeSession,
  CLAUDE_CODE_PROVIDER,
  commitClaudeSession,
  registerClaudeSession,
  runWithClaudeSession,
  setClaudeTaskListener,
  setClaudeToolListener,
  setClaudeWorkspaceTools,
  unregisterClaudeSession,
} from "./claude-code.ts";
import { buildSystemPrompt, type PromptConfig, type RuntimeContext } from "./system-prompt.ts";
import { TOOL_CALLS_ENTRY_TYPE, type RecordedToolCall, type ToolCallsEntryData } from "../threads/reader.ts";
import { DEFAULT_REASONING, PI_BUILTIN_TOOLS, type ModelEntry, type WorkspaceTool } from "../config.ts";
import { contentText, keyedLane, lruTouch } from "../util.ts";
import { logger } from "../log.ts";
import type { TaskActivityEvent } from "./task-activity.ts";

const log = logger("runner");

// Warm sessions: keep a thread's agent session alive between turns so a
// message doesn't pay a full cold start (settings + resource discovery +
// re-reading the whole session file) every time.
const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;
const MAX_WARM_SESSIONS = 32;

export interface TurnRequest {
  /** Absolute path of the pi session file (undefined → new session, file reported back). */
  sessionFile?: string;
  sessionDir: string;
  workspacePath: string;
  runtime: RuntimeContext;
  /** Ordered candidates: primary first, then fallbacks — each with its own
   * reasoning level and tool allowlist. */
  models: ModelEntry[];
  /** Provider-neutral workspace capability allowlist; undefined enables the curated default. */
  tools?: WorkspaceTool[];
  customTools?: ToolDefinition[];
  /** Resolved prompt for this turn (workspace system prompt + channel appends). */
  prompt?: PromptConfig;
  text: string;
  images?: ImageContent[];
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
  /** The attempt failed and is retrying on a fallback model — its prose is abandoned. */
  onFailover?: () => void;
  /** Raw pi event passthrough (channel lifecycle handling). */
  onEvent?: (event: AgentSessionEvent) => void;
  /** Provider-neutral tool activity for the dashboard. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Plan snapshots and native subagent lifecycle updates. */
  onTaskActivity?: (event: TaskActivityEvent) => void;
}

export interface TurnResult {
  sessionFile: string;
  /** All assistant prose produced this turn, message boundaries joined by blank lines. */
  text: string;
  model: string;
  status: "completed" | "stopped";
}

interface ActiveTurn {
  session: AgentSession;
  /** Settles when the turn ends — steering races against it to detect a missed injection. */
  done: Promise<void>;
  /** Set by interrupt() so the failover loop stops instead of retrying. */
  aborted: boolean;
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
  /** Narrow the live session to one candidate's tool allowlist. */
  applyToolPolicy: (entryTools?: WorkspaceTool[]) => void;
  lastUsedAt: number;
}

/** A candidate's effective policy: its allowlist ∩ the workspace's; undefined
 * on either side means "everything that side allows". */
function intersectTools(workspace?: WorkspaceTool[], entry?: WorkspaceTool[]): WorkspaceTool[] | undefined {
  if (!workspace) return entry;
  if (!entry) return workspace;
  return workspace.filter((tool) => entry.includes(tool));
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
        const result = await this.runTurn(threadId, request, events);
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
   */
  appendOutbound(threadId: string, sessionFile: string, modelReference: string, text: string): void {
    if (this.active.has(threadId)) throw new Error("thread has a running turn");
    const model = findModel(modelReference);
    if (!model) throw new Error(`unknown model ${modelReference}`);
    const warm = this.warm.get(threadId);
    const sessionManager = warm?.sessionManager ?? SessionManager.open(sessionFile);
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

    const warm = await this.acquireSession(threadId, request, models[0]);
    const { session, sessionManager, activeModel } = warm;
    // Mark the turn in-flight now that we have a session file: if the daemon is
    // killed mid-turn, this is what a restart uses to wake the conversation.
    this.hooks.onTurnStart?.(threadId, sessionManager.getSessionFile());
    let settle!: () => void;
    const active: ActiveTurn = { session, done: new Promise((resolve) => (settle = resolve)), aborted: false };
    this.active.set(threadId, active);

    const collected: string[] = [];
    let current = "";
    // pi does not reject prompt() on a provider failure or an abort — it settles
    // the run with an empty assistant message carrying stopReason "error"/"aborted".
    // Track the last one so the failover loop can tell those apart from a genuine
    // (retry-worthy) empty response.
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let attemptHadToolActivity = false;
    // Claude Code runs its own tool loop, so these calls never appear as
    // toolCall blocks in Pi's transcript. Collect them here and persist a
    // display-only custom entry once the attempt is accepted — that's what the
    // dashboard renders for nested-runtime turns.
    const claudeToolCalls: RecordedToolCall[] = [];
    setClaudeToolListener(session.sessionId, (name, args) => {
      attemptHadToolActivity = true;
      claudeToolCalls.push({ id: `claude:${claudeToolCalls.length}:${Date.now()}`, name, args });
      events.onToolCall?.(name, args);
    });
    const recordClaudeToolCalls = () => {
      if (!claudeToolCalls.length) return;
      const data: ToolCallsEntryData = { calls: claudeToolCalls.splice(0) };
      try {
        sessionManager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, data);
      } catch (error) {
        log.warn(`failed to record ${data.calls.length} tool call(s) for ${threadId}: ${error}`);
      }
    };
    setClaudeTaskListener(session.sessionId, (event) => events.onTaskActivity?.(event));
    const unsubscribe = session.subscribe((event) => {
      events.onEvent?.(event);
      if (event.type === "message_start") {
        current = "";
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        current += delta;
        events.onDelta?.(delta);
      } else if (event.type === "tool_execution_start") {
        attemptHadToolActivity = true;
        events.onToolCall?.(event.toolName, event.args);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        lastStopReason = message.stopReason;
        lastErrorMessage = message.errorMessage;
        // Some providers skip deltas and only deliver full text on message_end.
        const full = contentText(message.content);
        if (full.length > current.length) {
          events.onDelta?.(full.slice(current.length));
          current = full;
        }
        if (current.trim()) collected.push(current.trim());
        events.onAssistantText?.(current);
        current = "";
      }
    });

    try {
      let lastError: unknown;
      // pi persists the user message on every prompt(), even when the provider
      // errors — so a bare re-prompt on the next candidate would duplicate it.
      // Failover branches back to this entry instead, abandoning the failed
      // attempt (session files stay append-only; only the leaf pointer moves).
      const turnStart = sessionManager.getLeafId();
      for (const [index, { entry, model }] of models.entries()) {
        attemptHadToolActivity = false;
        claudeToolCalls.length = 0; // an abandoned attempt's calls are off the surviving branch
        if (index > 0) {
          log.warn(`falling over to ${modelRef(model)} for ${threadId}`);
          await rewindFailedAttempt(session, sessionManager, turnStart);
          // Prose from the abandoned attempt is off the surviving branch —
          // don't let it leak into this turn's result.
          collected.length = 0;
          events.onFailover?.();
          await session.setModel(model);
          // Each candidate runs with its own reasoning level and tool allowlist.
          session.setThinkingLevel(entry.reasoning ?? DEFAULT_REASONING);
          warm.applyToolPolicy(entry.tools);
          activeModel.current = modelRef(model);
        }
        lastStopReason = undefined;
        lastErrorMessage = undefined;
        try {
          await runWithClaudeSession(session.sessionId, () => session.prompt(request.text, { images: request.images }));
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
          if (model.provider === CLAUDE_CODE_PROVIDER) await commitClaudeSession(session.sessionId);
          recordClaudeToolCalls();
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
        recordClaudeToolCalls();
        this.dropSession(threadId);
        return { sessionFile: sessionManager.getSessionFile()!, text: collected.join("\n\n"), model: activeModel.current, status: "stopped" };
      }
      throw lastError ?? new Error("all models failed");
    } catch (error) {
      // A failed turn may leave the session in a dubious state — rebuild next time.
      this.dropSession(threadId);
      throw error;
    } finally {
      setClaudeToolListener(session.sessionId, undefined);
      setClaudeTaskListener(session.sessionId, undefined);
      unsubscribe();
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
    // absent: setModel/setThinkingLevel/applyToolPolicy below reconcile the
    // live session, so editing the sequence never discards a warm session.
    const signature = JSON.stringify([
      request.sessionDir,
      request.workspacePath,
      request.tools,
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
      cached.applyToolPolicy(initial.entry.tools);
      cached.activeModel.current = modelRef(initial.model);
      return cached;
    }
    this.dropSession(threadId);

    let sessionManager: SessionManager;
    if (request.sessionFile && existsSync(request.sessionFile)) {
      sessionManager = SessionManager.open(request.sessionFile, request.sessionDir, request.workspacePath);
    } else if (request.sessionFile) {
      // Pi defers creating a first-turn JSONL until an assistant message exists.
      // If the daemon died before that, preserve the UUID embedded in the
      // promised filename so Claude's durable active-attempt state remains reachable.
      const id = request.sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
      sessionManager = SessionManager.create(request.workspacePath, request.sessionDir, id ? { id } : undefined);
    } else {
      sessionManager = SessionManager.create(request.workspacePath, request.sessionDir);
    }

    // Mutable ref so the request-log extension tags payloads with the model
    // actually in use, even after a mid-turn failover.
    const activeModel = { current: modelRef(initial.model) };

    const settingsManager = SettingsManager.create(request.workspacePath, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: request.workspacePath,
      agentDir,
      settingsManager,
      // Global extensions stay off (they target pi's TUI); workspaces may ship
      // their own gateway-safe extensions in .pi/extensions.
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: workspaceExtensionFiles(request.workspacePath),
      additionalSkillPaths: workspaceResources(request.workspacePath).skillDirs,
      systemPrompt,
      // Inline extensions still load with noExtensions — pi's sanctioned hook
      // points (never touch streamFn).
      extensionFactories: this.hooks.onProviderRequest
        ? [{
            name: "eleven-request-log",
            factory: (pi: ExtensionAPI) => {
              pi.on("before_provider_request", (event) => {
                this.hooks.onProviderRequest?.(threadId, activeModel.current, event.payload);
                return undefined;
              });
            },
          }]
        : undefined,
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

    // Workspace extension tools (workflow, etc.) are Eleven-owned capabilities
    // just like channel tools. Keep Claude builtins native, but expose every
    // non-Pi tool through the isolated MCP bridge with its bound executor.
    const customNames = session.getAllTools()
      .map((tool) => tool.name)
      .filter((name) => !(PI_BUILTIN_TOOLS as readonly string[]).includes(name));
    registerClaudeSession(session.sessionId, {
      cwd: request.workspacePath,
      workspaceTools: request.tools,
      customTools: session.agent.state.tools.filter((tool) => customNames.includes(tool.name)),
    });

    // The workspace-wide active set (pi builtins the workspace allows +
    // extension/custom tools). A candidate's allowlist only ever gates the four
    // core capabilities inside it — extension and channel tools stay on.
    const baseActive = [...new Set([...session.getActiveToolNames(), ...customNames])];
    // Close over just this field: the closure lives as long as the warm
    // session, and capturing `request` would pin the turn's text and images.
    const workspaceTools = request.tools;
    const applyToolPolicy = (entryTools?: WorkspaceTool[]) => {
      const policy = intersectTools(workspaceTools, entryTools);
      const allowed = new Set<string>(policy ?? PI_BUILTIN_TOOLS);
      session.setActiveToolsByName(
        baseActive.filter((name) => !(PI_BUILTIN_TOOLS as readonly string[]).includes(name) || allowed.has(name)),
      );
      setClaudeWorkspaceTools(session.sessionId, policy);
    };
    applyToolPolicy(initial.entry.tools);

    const warm: WarmSession = {
      session,
      sessionManager,
      signature,
      customTools: request.customTools,
      activeModel,
      applyToolPolicy,
      lastUsedAt: Date.now(),
    };
    this.warm.set(threadId, warm);
    if (this.warm.size > MAX_WARM_SESSIONS) this.evictOldestSession(threadId);
    return warm;
  }

  private dropSession(threadId: string) {
    const warm = this.warm.get(threadId);
    if (!warm) return;
    unregisterClaudeSession(warm.session.sessionId);
    warm.session.dispose();
    this.warm.delete(threadId);
  }

  private evictIdleSessions() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [threadId, warm] of this.warm) {
      if (warm.lastUsedAt < cutoff && !this.active.has(threadId)) this.dropSession(threadId);
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
    } catch {
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
function workspaceExtensionFiles(workspacePath: string): string[] {
  const dir = join(workspacePath, ".pi", "extensions");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}


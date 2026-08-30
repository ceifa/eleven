import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConfigStore, ModelEntry, ModelScope, WorkspaceConfig } from "./config.ts";
import { listWorkspaceSkills, Runner, type TurnEvents, type TurnResult, type TurnRewind } from "./agent/runner.ts";
import { findModel } from "./agent/pi.ts";
import type { RuntimeContext } from "./agent/system-prompt.ts";
import { ThreadStore, type ThreadEntry } from "./threads/store.ts";
import { RequestLog } from "./threads/request-log.ts";
import { PendingTurns } from "./threads/pending.ts";
import { collectGarbage } from "./threads/gc.ts";
import { deleteReferencedMedia, sweepMedia } from "./media-store.ts";
import { rm } from "node:fs/promises";
import { THREADS_DIR } from "./paths.ts";
import { logger } from "./log.ts";
import { summarizeToolArgs } from "./util.ts";
import { collectProviderUsage, formatProviderUsage } from "./provider-usage.ts";
import { cleanupClaudeSessions } from "./agent/claude-code.ts";
import { TaskActivityBoard, type TaskActivityItem, type TaskActivitySection } from "./agent/task-activity.ts";

const log = logger("gateway");

/** The board as sent over the wire: plan rows grouped by producer, the agents,
 *  and how many agents exist (a producer may cap the rows it sends). */
const taskView = (live: LiveTurn) => ({
  tasks: { plan: live.tasks.sections, agents: live.tasks.agents, agentTotal: live.tasks.agentTotal },
});

const DEFAULT_IDLE_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 30;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// How recently a turn must have been interrupted for a restart to wake it back
// up — long enough to cover a self-restart (the agent updating eleven), short
// enough that a conversation cut off hours ago is left alone. Measured from the
// turn's last heartbeat, not its start: turns routinely run longer than any
// sane window before the restart that kills them.
const WAKE_WINDOW_MS = 5 * 60 * 1000;
const PENDING_HEARTBEAT_MS = 60 * 1000;
// In-memory activity of a running turn, so a dashboard opened mid-turn can
// catch up on what already happened (WS events only reach pages already open).
// It records prose, tool calls and provider requests *in order*: tool calls are
// also persisted to the session file, but the streamed prose is not, so the
// on-disk transcript alone can't say whether text came before or after a call.
const LIVE_TEXT_MAX_CHARS = 64_000;
const LIVE_ITEMS_MAX = 400;

export type LiveItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; args?: Record<string, unknown> }
  | { kind: "request"; id: string; model: string; at: number }
  // A message that arrived while the turn was running and was steered into it.
  // It is persisted immediately too, but only the live record knows *where* in
  // the turn it landed — the transcript cannot see the streamed prose it fell
  // between.
  | { kind: "message"; role: "user" | "assistant"; text: string; at: number };

export interface LiveTurn {
  startedAt: number;
  /** What the turn has produced so far, oldest first. */
  items: LiveItem[];
  /** Streamed characters kept so far, against LIVE_TEXT_MAX_CHARS. */
  chars: number;
  /** The turn's plan and subagents. Unlike `items` this is state, not a log:
   *  a page opened mid-turn needs the board as it stands, not the events that
   *  built it — so the whole board is what gets broadcast and served. */
  tasks: TaskActivityBoard;
}

/** The live turn as the dashboard consumes it (a board is not JSON on its own). */
export interface LiveTurnView {
  startedAt: number;
  items: LiveItem[];
  tasks: { plan: TaskActivitySection[]; agents: TaskActivityItem[]; agentTotal: number };
}

export interface IncomingMessage {
  /** Durable conversation identity, e.g. "telegram:main:12345". */
  sessionKey: string;
  text: string;
  images?: ImageContent[];
  /** Channel context for the system prompt (workspace fields are filled in here). */
  runtime: Omit<RuntimeContext, "workspace" | "workspacePath">;
  /** Channel tools (e.g. Telegram send/react) for this turn. */
  customTools?: ToolDefinition[];
  /** Default workspace for this conversation (e.g. the bot's configured one). */
  workspaceHint?: string;
  /** Channel-resolved model scopes, most specific first (topic, then group) —
   * they outrank the workspace's own model settings. */
  modelScopes?: (ModelScope | undefined)[];
  /** Explicit model plan for this turn, bypassing config resolution entirely —
   * a manual failover retries on the tail its failed turn never reached. */
  models?: ModelEntry[];
  /** Discard a failed attempt before this turn starts (a manual restart). */
  rewind?: TurnRewind;
  /** Channel-resolved appends (e.g. group then topic) added after the workspace prompt. */
  appends?: string[];
  events?: TurnEvents;
  /** Deliver the finished turn to the channel. The runner runs it inside the
   * thread's turn lane, so the pending ledger releases only after the send
   * settles — a daemon death between "model done" and "reply sent" wakes the
   * conversation instead of silently losing the reply. */
  deliver?: (result: TurnResult) => Promise<void>;
}

/**
 * The daemon core: resolves conversations to workspaces and threads, runs agent
 * turns, and broadcasts activity (consumed live by the dashboard).
 */
export class Gateway extends EventEmitter {
  readonly threads = new ThreadStore();
  readonly requests = new RequestLog();
  readonly pending = new PendingTurns();
  readonly runner = new Runner({
    onProviderRequest: (threadId, model, payload) => {
      const meta = this.requests.record(threadId, model, payload);
      this.pushLive(threadId, { kind: "request", id: meta.id, model, at: Date.now() });
      this.emit("provider-request", { threadId, id: meta.id, model });
    },
    onTurnStart: (threadId, sessionFile) => {
      // Pin the thread to its session file now, so an interrupted turn resumes
      // the same pi session (not just after a successful turn reports it back).
      if (sessionFile) this.threads.update(threadId, { sessionFile });
      this.pending.begin(threadId);
      // handle() opens the record when the message arrives, so the turn already
      // has the message that started it; only a turn nobody opened one for
      // (a woken interrupted turn) starts from scratch here.
      if (!this.liveTurns.has(threadId)) this.liveTurns.set(threadId, { startedAt: Date.now(), items: [], chars: 0, tasks: new TaskActivityBoard() });
      // Queued messages run back to back on the same thread: this is the only
      // point where a watcher can tell one turn's output from the next one's.
      this.emit("turn-start", { threadId });
    },
    // Fired inside the turn lane, after channel delivery — so the ledger
    // covers the send, and the next turn's begin cannot overlap this end.
    onTurnEnd: (threadId) => {
      this.pending.end(threadId);
      this.liveTurns.delete(threadId);
    },
    // The failure is already in the transcript; pin the thread to the file it
    // went into, so a first turn that never got a reply still has one to read.
    onTurnFailed: (threadId, sessionFile) => {
      if (sessionFile) this.threads.update(threadId, { sessionFile, lastActivityAt: Date.now() });
    },
  });

  private config: ConfigStore;
  private liveTurns = new Map<string, LiveTurn>();

  constructor(config: ConfigStore) {
    super();
    this.config = config;
    setInterval(() => this.pending.beat(), PENDING_HEARTBEAT_MS).unref();
    const gc = () => {
      void collectGarbage(this.threads, this.retentionMs(), this.idleMs());
      void sweepMedia(this.retentionMs());
    };
    gc();
    setInterval(gc, GC_INTERVAL_MS).unref();
  }

  async handle(incoming: IncomingMessage): Promise<TurnResult | undefined> {
    const { thread, workspace } = this.resolveThread(incoming.sessionKey, incoming.workspaceHint);
    log.info(`turn start: ${incoming.sessionKey} → ${thread.workspace}/${thread.id.slice(0, 8)}`);
    // Bump on arrival, not just on completion: listings are ordered by last
    // activity, so a thread whose turn is still running (they can take minutes)
    // must already sort above idle ones. One update → one persist.
    this.threads.update(thread.id, {
      lastActivityAt: Date.now(),
      ...(thread.title ? undefined : { title: incoming.text.slice(0, 80) }),
    });
    // A turn is already running: this message is about to be steered into it, so
    // it belongs in that turn's live record, at the point it arrived. Without it
    // a page opened mid-turn draws the message above everything the turn has
    // said since — the transcript has no idea where the streamed prose goes.
    //
    // And when none is running, this message is about to *start* a turn: open
    // the record here, so it holds the message the turn begins with. On a
    // thread's first turn that record is the only place the message exists —
    // pi keeps a brand-new session in memory until the model's first reply, so
    // there is no transcript file for a dashboard to read until the turn ends.
    if (!this.liveTurns.has(thread.id)) this.liveTurns.set(thread.id, { startedAt: Date.now(), items: [], chars: 0, tasks: new TaskActivityBoard() });
    this.pushLive(thread.id, { kind: "message", role: "user", text: incoming.text, at: Date.now() });
    this.emit("thread-activity", { thread, direction: "in", text: incoming.text });

    const events: TurnEvents = {
      ...incoming.events,
      onDelta: (delta) => {
        incoming.events?.onDelta?.(delta);
        const live = this.liveTurns.get(thread.id);
        if (live && live.chars < LIVE_TEXT_MAX_CHARS) {
          live.chars += delta.length;
          // Prose after a tool call is a new paragraph of the turn, not a
          // continuation of the last one — that's what keeps the order readable.
          const last = live.items.at(-1);
          if (last?.kind === "text") last.text += delta;
          else this.pushLive(thread.id, { kind: "text", text: delta });
        }
        this.emit("delta", { threadId: thread.id, delta });
      },
      onEvent: (event) => incoming.events?.onEvent?.(event),
      // A failover rewinds the transcript to the start of the turn, so whatever
      // the failed attempt streamed is off the surviving branch — drop it from
      // the live view too, instead of leaving orphan prose glued to the retry.
      onFailover: () => {
        incoming.events?.onFailover?.();
        const live = this.liveTurns.get(thread.id);
        if (live) {
          live.items = [];
          live.chars = 0;
        }
        this.emit("turn-rewound", { threadId: thread.id });
      },
      // Pi and nested runtimes report through the same clean event. Claude MCP
      // names are normalized by its adapter before they reach the dashboard.
      onToolCall: (name, args, id) => {
        incoming.events?.onToolCall?.(name, args, id);
        // Carry the durable call id and the full args: a dashboard watching the
        // turn can then open the call right away, instead of having to reload
        // the page to get the persisted (clickable) row.
        const summary = summarizeToolArgs(args);
        this.pushLive(thread.id, { kind: "tool", id, name, args, summary });
        this.emit("tool-call", { threadId: thread.id, id, name, args, summary });
      },
      // Broadcast the folded board rather than the raw event: a page that
      // connects mid-turn gets the same shape from the catch-up endpoint, so
      // the client never has to replay events to know what the plan looks like.
      onTaskActivity: (activity) => {
        incoming.events?.onTaskActivity?.(activity);
        const live = this.liveTurns.get(thread.id);
        if (!live) return;
        live.tasks.apply(activity);
        this.emit("task-activity", { threadId: thread.id, ...taskView(live) });
      },
    };

    const sessionDir = join(THREADS_DIR, thread.workspace);

    try {
      const result = await this.runner.submit(
        thread.id,
        {
          sessionFile: thread.sessionFile,
          sessionDir,
          workspacePath: workspace.config.path,
          runtime: { ...incoming.runtime, workspace: thread.workspace, workspacePath: workspace.config.path },
          models: incoming.models ?? this.config.turnModels(thread.model, [...(incoming.modelScopes ?? []), workspace.config]),
          tools: workspace.config.tools,
          excludeNativeTools: workspace.config.excludeNativeTools,
          customTools: incoming.customTools,
          prompt: { systemPrompt: workspace.config.systemPrompt, appends: incoming.appends },
          text: incoming.text,
          images: incoming.images,
          rewind: incoming.rewind,
          deliver: incoming.deliver,
        },
        events,
      );

      if (result) {
        this.threads.update(thread.id, { sessionFile: result.sessionFile, lastActivityAt: Date.now() });
        this.emit("thread-activity", { thread, direction: "out", text: result.text });
        this.emit("turn-done", { threadId: thread.id });
        log.info(`turn done: ${thread.id.slice(0, 8)} on ${result.model} (${result.text.length} chars)`);
      }
      return result;
    } catch (error) {
      this.emit("turn-error", { threadId: thread.id, error: String(error) });
      throw error;
    }
  }

  /**
   * Conversations whose turn was still running when the daemon last stopped and
   * that were interrupted recently enough to be worth resuming. Consumed once,
   * at startup: the ledger is drained so a later restart won't wake them again.
   */
  interruptedTurns(now = Date.now()): { sessionKey: string; threadId: string }[] {
    return this.pending.drain().flatMap((turn) => {
      if (now - turn.lastAliveAt >= WAKE_WINDOW_MS) return [];
      const thread = this.threads.get(turn.threadId);
      return thread ? [{ sessionKey: thread.sessionKey, threadId: thread.id }] : [];
    });
  }

  /** Start a fresh thread for a conversation (the /new command). Keeps prefs. */
  newThread(sessionKey: string, workspaceHint?: string): ThreadEntry {
    const workspace = this.workspaceFor(sessionKey, workspaceHint);
    const thread = this.threads.rotate(sessionKey, workspace.name, this.threads.current(sessionKey));
    // Whoever rotated it, every watcher's idea of the conversation's current
    // thread just went stale — a /new typed in Telegram included.
    this.emit("thread-started", { threadId: thread.id, workspace: thread.workspace });
    return thread;
  }

  /**
   * Delete a thread and every file tied to it: the pi session JSONL, the
   * provider-request log, and any media the transcript references. An in-flight
   * turn is aborted first so nothing writes the files back.
   */
  async deleteThread(id: string): Promise<boolean> {
    const thread = this.threads.get(id);
    if (!thread) return false;
    await this.runner.discard(id);
    if (thread.sessionFile) {
      await deleteReferencedMedia(thread.sessionFile);
      let sessionId: string | undefined;
      try { sessionId = SessionManager.open(thread.sessionFile).getSessionId(); } catch {
        sessionId = thread.sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
      }
      if (sessionId) await cleanupClaudeSessions(sessionId);
      await rm(thread.sessionFile, { force: true });
    }
    await this.requests.delete(id);
    this.threads.delete(id);
    log.info(`thread deleted: ${thread.workspace}/${id.slice(0, 8)}`);
    return true;
  }

  /** Abort the in-flight turn of a conversation (the /new and /stop commands). */
  async interrupt(sessionKey: string): Promise<boolean> {
    const thread = this.threads.current(sessionKey);
    return thread ? this.interruptThread(thread.id) : false;
  }

  /** Abort the in-flight turn of one specific thread. The dashboard stops the
   *  thread on screen, which is not necessarily its conversation's current one. */
  async interruptThread(id: string): Promise<boolean> {
    return this.runner.interrupt(id);
  }

  isThreadRunning(id: string): boolean {
    return this.runner.isRunning(id);
  }

  /** Activity of the thread's running turn, if one is in flight, in the shape
   *  the dashboard consumes (the board is a class, not JSON). */
  liveTurn(id: string): LiveTurnView | undefined {
    const live = this.liveTurns.get(id);
    return live ? { startedAt: live.startedAt, items: live.items, ...taskView(live) } : undefined;
  }

  /** Append to the running turn's live record, oldest entries falling off first
   *  so a very long turn can't grow it without bound. */
  private pushLive(threadId: string, item: LiveItem): void {
    const live = this.liveTurns.get(threadId);
    if (!live) return;
    live.items.push(item);
    // Dropped tool calls still reach a reloading page: they're persisted in the
    // session file, so they simply render as part of the durable transcript.
    if (live.items.length > LIVE_ITEMS_MAX) live.items.splice(0, live.items.length - LIVE_ITEMS_MAX);
  }

  /**
   * Serialize literal channel delivery with model turns, then persist it into
   * the same transcript. All failure-prone prerequisites are validated before
   * the external send; a post-send persistence failure is returned as a warning
   * so operators do not retry and duplicate a message the user already got.
   */
  async deliverOutbound<T>(id: string, text: string, deliver: () => Promise<T>): Promise<{ target: T; recorded: boolean; warning?: string }> {
    const thread = this.threads.get(id);
    if (!thread) throw new Error("thread not found");
    if (!this.threads.isCurrent(id)) {
      const current = this.threads.current(thread.sessionKey);
      throw new Error(`thread is old${current ? `; current thread is ${current.id.slice(0, 8)}` : ""}`);
    }
    const workspace = this.config.resolved.workspaces[thread.workspace];
    if (!workspace) throw new Error(`workspace ${thread.workspace} is not configured`);
    const candidates = this.config.turnModels(thread.model, [workspace]);
    const model = candidates.map((candidate) => candidate.model).find((ref) => findModel(ref));
    if (!model) throw new Error(`no known model among: ${candidates.map((c) => c.model).join(", ") || "none"}`);

    return this.runner.runWhenIdle(thread.id, async () => {
      // Re-check after entering the lane: /new may have rotated the conversation
      // between the initial validation and this operation acquiring its slot.
      if (!this.threads.isCurrent(id)) {
        const current = this.threads.current(thread.sessionKey);
        throw new Error(`thread is old${current ? `; current thread is ${current.id.slice(0, 8)}` : ""}`);
      }
      const target = await deliver();
      if (!this.threads.isCurrent(id)) {
        const current = this.threads.current(thread.sessionKey);
        const warning = `message was delivered after the conversation rotated; transcript was not changed${current ? ` (current thread ${current.id.slice(0, 8)})` : ""}`;
        log.warn(warning);
        return { target, recorded: false, warning };
      }
      try {
        // A destination that only ever received output has no session file yet;
        // appendOutbound creates one and reports it back, so the thread record
        // stops being a dangling stub after the first delivery.
        const sessionFile = this.runner.appendOutbound(thread.id, {
          sessionFile: thread.sessionFile,
          sessionDir: join(THREADS_DIR, thread.workspace),
          workspacePath: workspace.path,
        }, model, text);
        this.threads.update(thread.id, { sessionFile, lastActivityAt: Date.now() });
        this.emit("thread-activity", { thread, direction: "out", text });
        return { target, recorded: true };
      } catch (error) {
        const warning = `message was delivered but transcript recording failed: ${error instanceof Error ? error.message : error}`;
        log.error(warning);
        return { target, recorded: false, warning };
      }
    });
  }

  /** Skills a turn in this conversation's workspace would load. */
  async listSkills(sessionKey: string, workspaceHint?: string) {
    const workspace = this.workspaceFor(sessionKey, workspaceHint);
    return { workspace: workspace.name, skills: await listWorkspaceSkills(workspace.config.path) };
  }

  /** Live subscription quotas for every provider configured in eleven. */
  async providerUsage(): Promise<string> {
    const providers = [...new Set(this.config.configuredModelRefs().map((ref) => ref.split("/", 1)[0]))];
    if (!providers.length) throw new Error("no providers configured");
    const reports = await collectProviderUsage(providers);
    return reports
      .map((report) => report.usage
        ? formatProviderUsage(report.usage)
        : `**${report.provider}**\n- ⚠️ ${report.error ?? `subscription usage is not available for ${report.provider}`}`)
      .join("\n\n");
  }

  private idleMs(): number {
    return (this.config.resolved.session?.idleDays ?? DEFAULT_IDLE_DAYS) * 24 * 60 * 60 * 1000;
  }

  private retentionMs(): number {
    return (this.config.resolved.session?.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  }

  private workspaceFor(sessionKey: string, hint?: string): { name: string; config: WorkspaceConfig } {
    const config = this.config.resolved;
    // Prefer the thread's own workspace, but if it was removed/renamed in config
    // fall back to the hint (then the first workspace) instead of throwing — a
    // deleted workspace must not permanently brick its conversations.
    const candidates = [this.threads.current(sessionKey)?.workspace, hint, Object.keys(config.workspaces)[0]];
    const current = candidates[0];
    for (const name of candidates) {
      if (!name) continue;
      const workspace = config.workspaces[name];
      if (workspace) {
        if (name !== current && current) {
          log.warn(`workspace "${current}" is not configured, using "${name}" for ${sessionKey}`);
        }
        return { name, config: workspace };
      }
    }
    throw new Error(`no configured workspace for ${sessionKey} (wanted "${current ?? hint ?? "?"}")`);
  }

  private resolveThread(sessionKey: string, hint?: string) {
    const workspace = this.workspaceFor(sessionKey, hint);
    const thread = this.threads.resolve(sessionKey, workspace.name, this.idleMs());
    if (thread.workspace !== workspace.name) {
      // Thread was created under another workspace (e.g. /workspace switch) — honor it.
      const actual = this.config.resolved.workspaces[thread.workspace];
      if (actual) return { thread, workspace: { name: thread.workspace, config: actual } };
      log.warn(`thread ${thread.id} references removed workspace "${thread.workspace}", using "${workspace.name}"`);
    }
    return { thread, workspace };
  }
}


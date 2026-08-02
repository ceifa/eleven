import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConfigStore, ModelScope, WorkspaceConfig } from "./config.ts";
import { listWorkspaceSkills, Runner, type TurnEvents, type TurnResult } from "./agent/runner.ts";
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

const log = logger("gateway");
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
      this.emit("provider-request", { threadId, id: meta.id, model });
    },
    onTurnStart: (threadId, sessionFile) => {
      // Pin the thread to its session file now, so an interrupted turn resumes
      // the same pi session (not just after a successful turn reports it back).
      if (sessionFile) this.threads.update(threadId, { sessionFile });
      this.pending.begin(threadId);
    },
    // Fired inside the turn lane, after channel delivery — so the ledger
    // covers the send, and the next turn's begin cannot overlap this end.
    onTurnEnd: (threadId) => this.pending.end(threadId),
  });

  private config: ConfigStore;

  constructor(config: ConfigStore) {
    super();
    this.config = config;
    setInterval(() => this.pending.beat(), PENDING_HEARTBEAT_MS).unref();
    const gc = () => {
      void collectGarbage(this.threads, this.retentionMs());
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
    this.emit("thread-activity", { thread, direction: "in", text: incoming.text });

    const events: TurnEvents = {
      ...incoming.events,
      onDelta: (delta) => {
        incoming.events?.onDelta?.(delta);
        this.emit("delta", { threadId: thread.id, delta });
      },
      onEvent: (event) => incoming.events?.onEvent?.(event),
      // Pi and nested runtimes report through the same clean event. Claude MCP
      // names are normalized by its adapter before they reach the dashboard.
      onToolCall: (name, args) => {
        incoming.events?.onToolCall?.(name, args);
        this.emit("tool-call", { threadId: thread.id, name, summary: summarizeToolArgs(args) });
      },
      onTaskActivity: (activity) => {
        incoming.events?.onTaskActivity?.(activity);
        this.emit("task-activity", { threadId: thread.id, activity });
      },
    };

    try {
      const result = await this.runner.submit(
        thread.id,
        {
          sessionFile: thread.sessionFile,
          sessionDir: join(THREADS_DIR, thread.workspace),
          workspacePath: workspace.config.path,
          runtime: { ...incoming.runtime, workspace: thread.workspace, workspacePath: workspace.config.path },
          models: this.config.turnModels(thread.model, [...(incoming.modelScopes ?? []), workspace.config]),
          tools: workspace.config.tools,
          customTools: incoming.customTools,
          prompt: { systemPrompt: workspace.config.systemPrompt, appends: incoming.appends },
          text: incoming.text,
          images: incoming.images,
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
    return this.threads.rotate(sessionKey, workspace.name, this.threads.current(sessionKey));
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

  async interrupt(sessionKey: string): Promise<boolean> {
    const thread = this.threads.current(sessionKey);
    return thread ? this.runner.interrupt(thread.id) : false;
  }

  isThreadRunning(id: string): boolean {
    return this.runner.isRunning(id);
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
    if (!thread.sessionFile) throw new Error("thread has no session file");
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
        this.runner.appendOutbound(thread.id, thread.sessionFile!, model, text);
        this.threads.update(thread.id, { lastActivityAt: Date.now() });
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


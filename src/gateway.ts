import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isChannelSessionKey, type ConfigStore, type ModelEntry, type ModelScope, type WorkspaceConfig } from "./config.ts";
import { Runner } from "./agent/runner.ts";
import { listWorkspaceSkills } from "./agent/skills.ts";
import type { TurnEvents, TurnResult, TurnRewind } from "./agent/turn.ts";
import { findModel } from "./agent/pi.ts";
import type { RuntimeContext } from "./agent/system-prompt.ts";
import { ThreadStore, type ThreadEntry } from "./threads/store.ts";
import { RequestLog } from "./threads/request-log.ts";
import { PendingTurns } from "./threads/pending.ts";
import { collectGarbage, sessionIdOf } from "./threads/gc.ts";
import { retitle } from "./threads/title.ts";
import { deleteReferencedMedia, sweepMedia } from "./media-store.ts";
import { rm } from "node:fs/promises";
import { THREADS_DIR } from "./paths.ts";
import { logger } from "./log.ts";
import { summarizeToolArgs } from "./util.ts";
import { providerUsageSummary } from "./provider-usage.ts";
import { cleanupClaudeSessions } from "./agent/claude-code.ts";
import type { Panel } from "./agent/panels.ts";
import { LiveTurns, type LiveItem, type LiveTurnView } from "./live-turns.ts";

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

export type { LiveItem, LiveTurnView } from "./live-turns.ts";

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
  createBackground?: import("./agent/host-api.ts").BackgroundStatusFactory;
  expectedThreadId?: string;
  /** Commit the finished turn inside its producing thread's lane. The ID
   * stays fixed even if the conversation rotates while delivery settles. */
  deliver?: (result: TurnResult, threadId: string) => Promise<void>;
}

/**
 * The daemon core: resolves conversations to workspaces and threads, runs agent
 * turns, and broadcasts activity (consumed live by the dashboard).
 */
/** What the gateway announces as conversations move, each with its payload. */
export interface GatewayEvents {
  "thread-started": [{ threadId: string; workspace: string }];
  "thread-activity": [{ thread: ThreadEntry; direction: "in" | "out"; text: string }];
  "turn-start": [{ threadId: string; startedAt: number; items: LiveItem[] }];
  "turn-done": [{ threadId: string }];
  "turn-error": [{ threadId: string; error: string }];
  "turn-rewound": [{ threadId: string }];
  delta: [{ threadId: string; delta: string }];
  "tool-call": [{ threadId: string; id: string; name: string; args: Record<string, unknown>; summary: string; at: number }];
  "provider-request": [{ threadId: string; id: string; model: string }];
  panels: [{ threadId: string; panels: Panel[] }];
  "reply-queued": [];
}

export class Gateway extends EventEmitter<GatewayEvents> {
  readonly threads = new ThreadStore();
  readonly requests = new RequestLog();
  readonly pending = new PendingTurns();
  readonly runner = new Runner({
    onProviderRequest: (threadId, model, payload, images) => {
      const meta = this.requests.record(threadId, model, payload, images);
      this.live.push(threadId, { kind: "request", id: meta.id, model, at: Date.now() });
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
      const { startedAt, items } = this.live.open(threadId);
      // Queued messages run back to back on the same thread: this is the only
      // point where a watcher can tell one turn's output from the next one's.
      // The record rides along: a watcher that starts the turn over from nothing
      // drops the message that opened it, which on a first turn exists nowhere else.
      this.emit("turn-start", { threadId, startedAt, items: [...items] });
    },
    // Live activity always ends; a failed durable handoff stays recoverable.
    onTurnEnd: (threadId, preservePending) => {
      if (!preservePending) this.pending.end(threadId);
      this.live.end(threadId);
    },
    // The failure is already in the transcript; pin the thread to the file it
    // went into, so a first turn that never got a reply still has one to read.
    onTurnFailed: (threadId, sessionFile) => {
      if (sessionFile) this.threads.update(threadId, { sessionFile, lastActivityAt: Date.now() });
    },
  });

  /** Runs a turn nobody typed in a chat conversation. The daemon sets it:
   *  the channels own delivery, and the gateway does not know them. */
  waker?: (sessionKey: string, text: string, threadId?: string) => Promise<void>;
  private config: ConfigStore;
  private live = new LiveTurns();
  private sessionLifetimes = new Map<string, AbortController>();

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
    if (incoming.expectedThreadId && incoming.expectedThreadId !== thread.id) {
      throw new Error(`thread ${incoming.expectedThreadId.slice(0, 8)} is no longer the open conversation`);
    }
    log.info(`turn start: ${incoming.sessionKey} → ${thread.workspace}/${thread.id.slice(0, 8)}`);
    // Bump on arrival, not just on completion: listings are ordered by last
    // activity, so a thread whose turn is still running (they can take minutes)
    // must already sort above idle ones. One update → one persist.
    this.threads.update(thread.id, {
      lastActivityAt: Date.now(),
      ...(retitle(thread.title, incoming.text) ?? {}),
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
    this.live.open(thread.id);
    this.live.push(thread.id, { kind: "message", role: "user", text: incoming.text, at: Date.now() });
    this.emit("thread-activity", { thread, direction: "in", text: incoming.text });

    const events: TurnEvents = {
      ...incoming.events,
      onDelta: (delta) => {
        incoming.events?.onDelta?.(delta);
        this.live.text(thread.id, delta);
        this.emit("delta", { threadId: thread.id, delta });
      },
      onEvent: (event) => incoming.events?.onEvent?.(event),
      // A failover rewinds the transcript to the start of the turn, so whatever
      // the failed attempt streamed is off the surviving branch — drop it from
      // the live view too, instead of leaving orphan prose glued to the retry.
      onFailover: () => {
        incoming.events?.onFailover?.();
        this.live.rewind(thread.id);
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
        const at = Date.now();
        this.live.push(thread.id, { kind: "tool", id, name, args, summary, at });
        this.emit("tool-call", { threadId: thread.id, id, name, args, summary, at });
      },
      // Broadcast every producer's panels rather than the one update: a page
      // that connects mid-turn gets the same shape from the catch-up endpoint,
      // so the client never has to replay updates to know what is on screen.
      onPanels: (update) => {
        incoming.events?.onPanels?.(update);
        const panels = this.live.panels(thread.id, update);
        if (panels) this.emit("panels", { threadId: thread.id, panels });
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
          // Someone comes back to a Telegram or Discord conversation hours later;
          // a dashboard, CLI or cron thread is done when its caller is.
          compactWhenIdle: this.openChannelConversation(thread.id),
          deliver: incoming.deliver && ((result) => incoming.deliver!(result, thread.id)),
          wake: this.wakeFor(thread),
          sessionSignal: this.sessionSignal(thread),
          createBackground: incoming.createBackground,
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

  queueReply(threadId: string, sessionKey: string, text: string, replyTo?: string) {
    const thread = this.threads.get(threadId);
    if (!thread || thread.sessionKey !== sessionKey) throw new Error("reply conversation is missing");
    this.pending.complete(thread.id, sessionKey, text, replyTo);
    this.emit("reply-queued");
  }

  hasPendingReply(sessionKey: string) {
    return this.pending.hasReply(sessionKey);
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

  /** When the conversation's current thread began, if its next turn will go on
   *  in it rather than start over (idle expiry, /new) — what tells a channel
   *  whether the agent already holds something said earlier. */
  continuingSince(sessionKey: string): number | undefined {
    const thread = this.threads.current(sessionKey);
    if (!thread || !(thread.persistent || Date.now() - thread.lastActivityAt <= this.idleMs())) return undefined;
    return thread.createdAt;
  }

  /** Start a fresh thread for a conversation (the /new command). Keeps prefs. */
  newThread(sessionKey: string, workspaceHint?: string): ThreadEntry {
    const workspace = this.workspaceFor(sessionKey, workspaceHint);
    const previous = this.threads.current(sessionKey);
    if (previous) this.endSession(previous.id);
    const thread = this.threads.rotate(sessionKey, workspace.name, previous);
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
    this.endSession(id);
    await this.runner.discard(id);
    if (thread.sessionFile) {
      await deleteReferencedMedia(thread.sessionFile);
      const sessionId = await sessionIdOf(thread.sessionFile);
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

  /** Activity of the thread's running turn, if one is in flight. */
  liveTurn(id: string): LiveTurnView | undefined {
    return this.live.get(id);
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
    const current = () => this.threads.current(thread.sessionKey)?.id.slice(0, 8);
    const assertCurrent = () => {
      if (!this.threads.isCurrent(id)) throw new Error(`thread is old${current() ? `; current thread is ${current()}` : ""}`);
    };
    assertCurrent();
    const workspace = this.config.resolved.workspaces[thread.workspace];
    if (!workspace) throw new Error(`workspace ${thread.workspace} is not configured`);
    const candidates = this.config.turnModels(thread.model, [workspace]);
    const model = candidates.map((candidate) => candidate.model).find((ref) => findModel(ref));
    if (!model) throw new Error(`no known model among: ${candidates.map((c) => c.model).join(", ") || "none"}`);

    return this.runner.runWhenIdle(thread.id, async () => {
      // Re-check after entering the lane: /new may have rotated the conversation
      // between the initial validation and this operation acquiring its slot.
      assertCurrent();
      const target = await deliver();
      if (!this.threads.isCurrent(id)) {
        const warning = `message was delivered after the conversation rotated; transcript was not changed${current() ? ` (current thread ${current()})` : ""}`;
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
    return providerUsageSummary(this.config.configuredLogins());
  }

  /** A Telegram or Discord conversation still attached to its chat: neither
   * replaced by /new nor archived. */
  private openChannelConversation(id: string): () => boolean {
    // Built here, not inline in handle(): a closure there would share its scope
    // and pin the turn's text and images until the idle timer fires.
    return () => {
      const thread = this.threads.get(id);
      return !!thread && this.threads.isCurrent(id) && !thread.archiveRequested && isChannelSessionKey(thread.sessionKey);
    };
  }

  private sessionSignal(thread: ThreadEntry): AbortSignal | undefined {
    if (!isChannelSessionKey(thread.sessionKey)) return undefined;
    let lifetime = this.sessionLifetimes.get(thread.id);
    if (!lifetime) {
      lifetime = new AbortController();
      this.sessionLifetimes.set(thread.id, lifetime);
    }
    return lifetime.signal;
  }

  private endSession(id: string): void {
    this.sessionLifetimes.get(id)?.abort();
    this.sessionLifetimes.delete(id);
  }

  /** How work a turn left running reports back later — only into the same
   * chat conversation, and only while it is still open. */
  private wakeFor(thread: ThreadEntry): ((text: string) => Promise<void>) | undefined {
    const waker = this.waker;
    if (!waker || !isChannelSessionKey(thread.sessionKey)) return undefined;
    const open = this.openChannelConversation(thread.id);
    const { id, sessionKey } = thread;
    return async (text) => {
      if (!open()) throw new Error(`thread ${id.slice(0, 8)} is no longer the open conversation in ${sessionKey}`);
      await waker(sessionKey, text, id);
    };
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
    const previous = this.threads.current(sessionKey);
    const thread = this.threads.resolve(sessionKey, workspace.name, this.idleMs());
    if (previous && previous.id !== thread.id) this.endSession(previous.id);
    if (thread.workspace !== workspace.name) {
      // Thread was created under another workspace (e.g. /workspace switch) — honor it.
      const actual = this.config.resolved.workspaces[thread.workspace];
      if (actual) return { thread, workspace: { name: thread.workspace, config: actual } };
      log.warn(`thread ${thread.id} references removed workspace "${thread.workspace}", using "${workspace.name}"`);
    }
    return { thread, workspace };
  }
}


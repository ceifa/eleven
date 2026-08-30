import type { Api } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import { displayId, TaskActivityBoard, type TaskActivityEvent, type TaskActivityItem, type TaskActivitySection } from "../../agent/task-activity.ts";
import { logger } from "../../log.ts";
import { isNoop, withRetry } from "./retry.ts";
import { ephemeralReceiver, noteEphemeralRefused } from "./ephemeral.ts";

const log = logger("telegram/tasks");
const FIRST_RENDER_DELAY_MS = 250;
// A tool-status-only message has no lasting value — hold it back long enough
// that quick turns never spawn one.
const TOOL_FIRST_RENDER_DELAY_MS = 4_000;
// A turn can also produce nothing at all for minutes — a provider stalling on
// the very first request. Say something anyway: silence in a chat reads as "it
// never saw my message", and that is exactly what it does not mean.
const IDLE_FIRST_RENDER_DELAY_MS = 12_000;
// Refresh the elapsed time in the running header between events; only show it
// once the turn stops feeling instant.
const ELAPSED_TICK_MS = 10_000;
const ELAPSED_MIN_MS = 10_000;
const THROTTLE_MS = 900;
const MAX_PLAN_ROWS = 12;
const MAX_AGENT_ROWS = 8;
const MAX_TEXT = 4_000;

export type TaskProgressOutcome = "completed" | "failed" | "stopped";

/** Live-turn status for the header line: the last top-level tool the model
 * started, plus how long the turn has been running. */
export interface RunningStatus {
  tool?: { name: string; summary?: string };
  elapsedMs: number;
}

/** A retryable provider failure the runtime is working around. */
export interface RetryStatus {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
}

export interface TaskProgressOptions {
  topic?: number;
  replyParameters?: ReplyParameters;
  /** Post the status as an ephemeral message only this user sees. Status is
   * scaffolding, not conversation — in a shared group nobody else needs it. */
  ephemeralTo?: number;
  /** Hold-off before a tool-status-only message appears; `Infinity` suppresses
   * it entirely (a draft preview already covers that job in private chats). */
  toolRenderDelayMs?: number;
  /** Hold-off before an event-less turn reports that it is working; `Infinity`
   * suppresses it entirely. */
  idleRenderDelayMs?: number;
}

/** One quiet, editable Telegram message for a turn's plan, subagents, the
 * top-level tool currently running, and provider retries. Plan/agent content and
 * retries are a durable record of the turn; a message that only ever showed tool
 * status is deleted when the turn ends — the reply (or failure notice) that
 * follows supersedes it. */
export class TelegramTaskProgress {
  private readonly board = new TaskActivityBoard();
  /** Tools whose own rows are on screen — their argument preview adds nothing. */
  private readonly reporting = new Set<string>();
  private readonly startedAt = Date.now();
  private currentTool: RunningStatus["tool"];
  private currentRetry: RetryStatus | undefined;
  /** Plan/agent content appeared — the message is worth keeping after finish. */
  private hasTasks = false;
  private messageId: number | undefined;
  private ephemeralMessageId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private lastSentAt = 0;
  private lastText = "";
  private pendingText: string | undefined;
  private draining: Promise<void> | undefined;
  private outcome: TaskProgressOutcome | undefined;
  private dead = false;
  private readonly api: Api;
  private readonly chatId: number;
  private readonly topic: number | undefined;
  private readonly replyParameters: ReplyParameters | undefined;
  private ephemeralTo: number | undefined;
  private readonly toolRenderDelayMs: number;
  private readonly idleRenderDelayMs: number;

  constructor(api: Api, chatId: number, options: TaskProgressOptions = {}) {
    this.api = api;
    this.chatId = chatId;
    this.topic = options.topic;
    this.replyParameters = options.replyParameters;
    this.ephemeralTo = ephemeralReceiver(chatId, options.ephemeralTo);
    this.toolRenderDelayMs = options.toolRenderDelayMs ?? TOOL_FIRST_RENDER_DELAY_MS;
    this.idleRenderDelayMs = options.idleRenderDelayMs ?? IDLE_FIRST_RENDER_DELAY_MS;
  }

  /** The turn began. Arms the bare "working" header for a turn that produces no
   * events at all — the case that used to be indistinguishable from a lost message. */
  start(): void {
    this.schedule();
  }

  /** The provider failed and the runtime is retrying the same turn. This is the
   * reason a turn can go quiet for minutes, so it is worth showing live and
   * keeping in the chat once the turn ends. */
  retry(status: RetryStatus): void {
    if (this.dead || this.outcome) return;
    this.currentRetry = status;
    this.rearm();
  }

  update(event: TaskActivityEvent): void {
    if (this.dead || this.outcome) return;
    this.board.apply(event);
    // A seeded plan is context from an earlier turn: it may be drawn, but it
    // must not be the reason this turn posts a status message at all.
    this.hasTasks = this.board.changed;
    // A tool that reports its own phases has just said more than its arguments
    // ever could — the "🔧 workflow · script: export const meta…" line under a
    // live phase list is noise.
    if (event.kind === "plan" && event.label) {
      this.reporting.add(event.label);
      if (this.currentTool?.name === event.label) this.currentTool = undefined;
    }
    this.rearm();
  }

  /** Note the top-level tool the model just started — shown while the turn runs.
   *  Tools that report their own progress are left to their rows. */
  tool(name: string, summary: string): void {
    if (this.dead || this.outcome) return;
    if (this.reporting.has(name)) return;
    this.currentTool = { name, summary: summary || undefined };
    this.rearm();
  }

  async finish(outcome: TaskProgressOutcome): Promise<void> {
    if (this.dead || this.outcome) return;
    if (!this.worthKeeping) {
      // Tool-status-only message: the reply (or failure notice) that follows
      // supersedes it. Clean up off the reply's critical path — the delete's
      // outcome affects nothing downstream.
      this.cancel();
      void Promise.resolve(this.draining).then(() => {
        if (!this.posted) return;
        return withRetry("idempotent", "delete task progress", () =>
          this.ephemeralMessageId !== undefined
            ? this.api.raw.deleteEphemeralMessage({
              chat_id: this.chatId,
              receiver_user_id: this.ephemeralTo!,
              ephemeral_message_id: this.ephemeralMessageId,
            })
            : this.api.raw.deleteMessage({ chat_id: this.chatId, message_id: this.messageId! }),
        );
      }).catch((error) => {
        if (!isNoop(error)) log.warn(`status cleanup failed for chat ${this.chatId}: ${error}`);
      });
      return;
    }
    this.stopTimers();
    this.outcome = outcome;
    if (outcome !== "completed") this.board.settle(outcome === "failed" ? "failed" : "stopped");
    await this.queueRender();
  }

  cancel(): void {
    this.dead = true;
    this.stopTimers();
  }

  /** Plan/agent content and retries outlive the turn; bare tool status does not. */
  private get worthKeeping(): boolean {
    return this.hasTasks || !!this.currentRetry;
  }

  /** The status message exists in the chat — ephemeral or ordinary. */
  private get posted(): boolean {
    return this.messageId !== undefined || this.ephemeralMessageId !== undefined;
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** Richer content shortens the hold-off — re-arm against the new deadline. */
  private rearm(): void {
    if (this.timer && !this.lastSentAt) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.dead || this.outcome) return;
    const hold = this.hasTasks || this.currentRetry
      ? FIRST_RENDER_DELAY_MS
      : this.currentTool
        ? this.toolRenderDelayMs
        : this.idleRenderDelayMs;
    // An infinite hold-off means this kind of content never earns a message of
    // its own; richer content re-arms with a finite one.
    if (!this.posted && !Number.isFinite(hold)) return;
    const delay = this.lastSentAt
      ? Math.max(0, THROTTLE_MS - (Date.now() - this.lastSentAt))
      : Math.max(0, this.startedAt + hold - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.queueRender();
    }, delay);
  }

  private queueRender(): Promise<void> {
    const running = this.outcome
      ? undefined
      : { tool: this.currentTool, elapsedMs: Date.now() - this.startedAt };
    let text = renderTaskActivity(
      this.board.sections,
      this.board.agents,
      this.outcome,
      running,
      this.currentRetry,
      this.board.agentTotal,
    );
    if (!text && this.messageId !== undefined) text = "📋 No active tasks";
    if (!text || text === this.lastText || text === this.pendingText || this.dead) return this.draining ?? Promise.resolve();
    this.pendingText = text; // latest wins while Telegram is slow
    if (!this.draining) {
      this.draining = this.drain().finally(() => { this.draining = undefined; });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pendingText !== undefined && !this.dead) {
        const text = this.pendingText;
        this.pendingText = undefined;
        const wait = this.lastSentAt ? Math.max(0, this.lastSentAt + THROTTLE_MS - Date.now()) : 0;
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (this.dead) return;
        if (!this.posted) await this.post(text);
        else await this.repost(text);
        this.lastText = text;
        this.lastSentAt = Date.now();
      }
    } catch (error) {
      this.dead = true;
      this.stopTimers();
      log.warn(`task progress disabled for chat ${this.chatId}: ${error}`);
    }
  }

  /** First render: post the message, ephemeral when asked for. */
  private async post(text: string): Promise<void> {
    const common = {
      chat_id: this.chatId,
      message_thread_id: this.topic,
      text,
      reply_parameters: this.replyParameters,
      disable_notification: true,
    };
    if (this.ephemeralTo !== undefined) {
      try {
        const message = await withRetry("send", "send ephemeral task progress", () =>
          this.api.raw.sendMessage({ ...common, ephemeral_message_parameters: { receiver_user_id: this.ephemeralTo! } }),
        );
        // A chat where ephemeral delivery didn't apply answers with an ordinary
        // message — carry on editing it as one.
        if (message.ephemeral_message_id !== undefined) this.ephemeralMessageId = message.ephemeral_message_id;
        else {
          this.messageId = message.message_id;
          noteEphemeralRefused(this.chatId);
          this.ephemeralTo = undefined;
        }
      } catch (error) {
        // Ephemeral is a courtesy to the other people in the chat, not the
        // point: a chat that refuses it still deserves to see the status.
        log.warn(`ephemeral status rejected in chat ${this.chatId}, posting normally: ${error}`);
        noteEphemeralRefused(this.chatId);
        this.ephemeralTo = undefined;
      }
    }
    if (!this.posted) {
      const message = await withRetry("send", "send task progress", () => this.api.raw.sendMessage(common));
      this.messageId = message.message_id;
    }
    // From here on the running header shows elapsed time — keep it honest
    // between events. queueRender directly: the tick always exceeds the
    // throttle, which drain() enforces anyway.
    this.ticker ??= setInterval(() => {
      if (!this.dead && !this.outcome) void this.queueRender();
    }, ELAPSED_TICK_MS);
    this.ticker.unref();
  }

  /** Later renders: edit the message in place. */
  private async repost(text: string): Promise<void> {
    try {
      await withRetry("idempotent", "edit task progress", () =>
        this.ephemeralMessageId !== undefined
          ? this.api.raw.editEphemeralMessageText({
            chat_id: this.chatId,
            receiver_user_id: this.ephemeralTo!,
            ephemeral_message_id: this.ephemeralMessageId,
            text,
          })
          : this.api.raw.editMessageText({ chat_id: this.chatId, message_id: this.messageId!, text }),
      );
    } catch (error) {
      if (!isNoop(error)) throw error;
    }
  }
}

export function renderTaskActivity(
  plan: readonly TaskActivitySection[],
  agents: readonly TaskActivityItem[],
  outcome?: TaskProgressOutcome,
  running?: RunningStatus,
  retry?: RetryStatus,
  /** Agents that exist, when more of them ran than were reported. */
  agentTotal = agents.length,
): string {
  const elapsed = running && running.elapsedMs >= ELAPSED_MIN_MS ? ` · ${formatDuration(running.elapsedMs)}` : "";
  const header = outcome === "failed"
    ? "❌ Turn ended with an error"
    : outcome === "stopped"
      ? "⏹ Turn stopped"
      : outcome === "completed"
        ? "✅ Turn completed"
        : `⚙️ Agent working${elapsed}`;
  const tool = running?.tool;
  const lines = [header];
  if (retry) lines.push(`🔁 Retry ${retry.attempt}/${retry.maxAttempts} · ${compact(retry.errorMessage, 90)}`);
  if (tool) lines.push(`🔧 ${tool.name}${tool.summary ? ` · ${compact(tool.summary, 80)}` : ""}`);
  const head = lines.join("\n");
  // A bare running header is the whole point of an event-less turn: it says the
  // message arrived. Only a call with nothing at all to report renders empty.
  const planRows = plan.reduce((sum, section) => sum + section.tasks.length, 0);
  if (!planRows && !agents.length) return outcome || running || retry ? head : "";
  const sections = [head];
  // The session's plan and a tool's internal phases are different things and
  // get different headings — merged, a reader cannot tell which is theirs.
  for (const section of plan) {
    if (!section.tasks.length) continue;
    const title = `📋 ${section.label ?? "Plan"}`;
    sections.push(renderSection(title, section.tasks, MAX_PLAN_ROWS, renderPlanRow, section.tasks.length));
  }
  if (agents.length) sections.push(renderSection("🤖 Agents", agents, MAX_AGENT_ROWS, renderAgentRow, agentTotal));
  const text = sections.join("\n\n");
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

/** `total` is how many exist, which is not always how many arrived: a producer
 *  may cap the rows it sends. Counting the rows instead would understate a
 *  40-agent fan-out as "… 2 more". */
function renderSection(
  title: string,
  tasks: readonly TaskActivityItem[],
  limit: number,
  row: (task: TaskActivityItem) => string,
  total: number,
): string {
  const visible = tasks.slice(0, limit).map(row);
  const hidden = total - Math.min(tasks.length, limit);
  if (hidden > 0) visible.push(`… ${hidden} more`);
  return `${title}\n${visible.join("\n")}`;
}

function renderPlanRow(task: TaskActivityItem): string {
  const blocked = task.blockedBy?.length ? ` · blocked by ${task.blockedBy.map((id) => `#${displayId(id)}`).join(", ")}` : "";
  return `${statusIcon(task)} ${compact(task.title)}${blocked}`;
}

function renderAgentRow(task: TaskActivityItem): string {
  const details: string[] = [];
  if (task.status === "running" && task.lastToolName) details.push(task.lastToolName);
  if (task.usage?.durationMs !== undefined) details.push(formatDuration(task.usage.durationMs));
  if (task.usage?.totalTokens !== undefined) details.push(formatTokens(task.usage.totalTokens));
  if (task.status !== "running" && task.summary && normalized(task.summary) !== normalized(task.title)) {
    details.push(compact(task.summary, 70));
  }
  return `${statusIcon(task)} ${compact(task.title)}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function statusIcon(task: TaskActivityItem): string {
  if (task.status === "completed") return "✅";
  if (task.status === "failed") return "❌";
  if (task.status === "stopped") return "⏹";
  if (task.status === "running") return "⏳";
  return task.blockedBy?.length ? "⏸" : "○";
}

function compact(value: string, limit = 120): string {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function normalized(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `${tokens} tok`;
}

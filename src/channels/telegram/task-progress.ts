import type { Api } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import type { TaskActivityEvent, TaskActivityItem } from "../../agent/task-activity.ts";
import { logger } from "../../log.ts";
import { isNoop, withRetry } from "./retry.ts";

const log = logger("telegram/tasks");
const FIRST_RENDER_DELAY_MS = 250;
// A tool-status-only message has no lasting value — hold it back long enough
// that quick turns never spawn one.
const TOOL_FIRST_RENDER_DELAY_MS = 4_000;
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

/** One quiet, editable Telegram message for a turn's plan, subagents, and the
 * top-level tool currently running. Plan/agent content is a durable record of
 * the turn; a message that only ever showed tool status is deleted when the
 * turn ends — the reply (or failure notice) that follows supersedes it. */
export class TelegramTaskProgress {
  private readonly plan = new Map<string, TaskActivityItem>();
  private readonly agents = new Map<string, TaskActivityItem>();
  private readonly startedAt = Date.now();
  private currentTool: RunningStatus["tool"];
  /** Plan/agent content appeared — the message is worth keeping after finish. */
  private hasTasks = false;
  private messageId: number | undefined;
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
  private readonly toolRenderDelayMs: number;

  constructor(api: Api, chatId: number, topic?: number, replyParameters?: ReplyParameters, toolRenderDelayMs = TOOL_FIRST_RENDER_DELAY_MS) {
    this.api = api;
    this.chatId = chatId;
    this.topic = topic;
    this.replyParameters = replyParameters;
    this.toolRenderDelayMs = toolRenderDelayMs;
  }

  update(event: TaskActivityEvent): void {
    if (this.dead || this.outcome) return;
    if (!this.hasTasks && this.timer) {
      // Task content upgrades the first render from the long tool-only
      // hold-off to the prompt one — rearm.
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.hasTasks = true;
    if (event.kind === "plan") {
      this.plan.clear();
      for (const task of event.tasks) this.plan.set(task.id, task);
    } else {
      const previous = this.agents.get(event.task.id);
      this.agents.set(event.task.id, previous ? { ...previous, ...event.task } : event.task);
    }
    this.schedule();
  }

  /** Note the top-level tool the model just started — shown while the turn runs. */
  tool(name: string, summary: string): void {
    if (this.dead || this.outcome) return;
    this.currentTool = { name, summary: summary || undefined };
    this.schedule();
  }

  async finish(outcome: TaskProgressOutcome): Promise<void> {
    if (this.dead || this.outcome) return;
    if (!this.hasTasks) {
      // Tool-status-only message: the reply (or failure notice) that follows
      // supersedes it. Clean up off the reply's critical path — the delete's
      // outcome affects nothing downstream.
      this.cancel();
      void Promise.resolve(this.draining).then(() => {
        const messageId = this.messageId;
        if (messageId === undefined) return;
        return withRetry("idempotent", "delete task progress", () =>
          this.api.raw.deleteMessage({ chat_id: this.chatId, message_id: messageId }),
        );
      }).catch((error) => {
        if (!isNoop(error)) log.warn(`tool status cleanup failed for chat ${this.chatId}: ${error}`);
      });
      return;
    }
    this.stopTimers();
    this.outcome = outcome;
    if (outcome !== "completed") {
      const terminal = outcome === "failed" ? "failed" : "stopped";
      for (const [id, task] of this.agents) {
        if (task.status === "running") this.agents.set(id, { ...task, status: terminal });
      }
    }
    await this.queueRender();
  }

  cancel(): void {
    this.dead = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = this.lastSentAt
      ? Math.max(0, THROTTLE_MS - (Date.now() - this.lastSentAt))
      : this.hasTasks
        ? FIRST_RENDER_DELAY_MS
        : this.toolRenderDelayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.queueRender();
    }, delay);
  }

  private queueRender(): Promise<void> {
    const running = this.outcome
      ? undefined
      : { tool: this.currentTool, elapsedMs: Date.now() - this.startedAt };
    let text = renderTaskActivity([...this.plan.values()], [...this.agents.values()], this.outcome, running);
    if (!text && this.messageId !== undefined) text = "📋 Nenhuma tarefa ativa";
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
        if (this.messageId === undefined) {
          const message = await withRetry("send", "send task progress", () => this.api.raw.sendMessage({
            chat_id: this.chatId,
            message_thread_id: this.topic,
            text,
            reply_parameters: this.replyParameters,
            disable_notification: true,
          }));
          this.messageId = message.message_id;
          // From here on the running header shows elapsed time — keep it honest
          // between events. queueRender directly: the tick always exceeds the
          // throttle, which drain() enforces anyway.
          this.ticker ??= setInterval(() => {
            if (!this.dead && !this.outcome) void this.queueRender();
          }, ELAPSED_TICK_MS);
          this.ticker.unref();
        } else {
          try {
            await withRetry("idempotent", "edit task progress", () => this.api.raw.editMessageText({
              chat_id: this.chatId,
              message_id: this.messageId,
              text,
            }));
          } catch (error) {
            if (!isNoop(error)) throw error;
          }
        }
        this.lastText = text;
        this.lastSentAt = Date.now();
      }
    } catch (error) {
      this.dead = true;
      this.stopTimers();
      log.warn(`task progress disabled for chat ${this.chatId}: ${error}`);
    }
  }
}

export function renderTaskActivity(
  plan: readonly TaskActivityItem[],
  agents: readonly TaskActivityItem[],
  outcome?: TaskProgressOutcome,
  running?: RunningStatus,
): string {
  const elapsed = running && running.elapsedMs >= ELAPSED_MIN_MS ? ` · ${formatDuration(running.elapsedMs)}` : "";
  const header = outcome === "failed"
    ? "❌ Turno encerrado com erro"
    : outcome === "stopped"
      ? "⏹ Turno interrompido"
      : outcome === "completed"
        ? "✅ Turno concluído"
        : `⚙️ Claude trabalhando${elapsed}`;
  const tool = running?.tool;
  const head = tool
    ? `${header}\n🔧 ${tool.name}${tool.summary ? ` · ${compact(tool.summary, 80)}` : ""}`
    : header;
  if (!plan.length && !agents.length) return outcome || tool ? head : "";
  const sections = [head];
  if (plan.length) sections.push(renderSection("📋 Plano", plan, MAX_PLAN_ROWS, renderPlanRow));
  if (agents.length) sections.push(renderSection("🤖 Agentes", agents, MAX_AGENT_ROWS, renderAgentRow));
  const text = sections.join("\n\n");
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

function renderSection(
  title: string,
  tasks: readonly TaskActivityItem[],
  limit: number,
  row: (task: TaskActivityItem) => string,
): string {
  const visible = tasks.slice(0, limit).map(row);
  if (tasks.length > limit) visible.push(`… mais ${tasks.length - limit}`);
  return `${title}\n${visible.join("\n")}`;
}

function renderPlanRow(task: TaskActivityItem): string {
  const blocked = task.blockedBy?.length ? ` · bloqueada por ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
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

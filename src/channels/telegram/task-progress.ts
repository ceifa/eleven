import type { Api } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import type { TaskActivityEvent, TaskActivityItem } from "../../agent/task-activity.ts";
import { logger } from "../../log.ts";
import { isNoop, withRetry } from "./retry.ts";

const log = logger("telegram/tasks");
const FIRST_RENDER_DELAY_MS = 250;
const THROTTLE_MS = 900;
const MAX_PLAN_ROWS = 12;
const MAX_AGENT_ROWS = 8;
const MAX_TEXT = 4_000;

export type TaskProgressOutcome = "completed" | "failed" | "stopped";

/** One quiet, editable Telegram message for a turn's plan and subagents. */
export class TelegramTaskProgress {
  private readonly plan = new Map<string, TaskActivityItem>();
  private readonly agents = new Map<string, TaskActivityItem>();
  private messageId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastSentAt = 0;
  private lastText = "";
  private pendingText: string | undefined;
  private draining: Promise<void> | undefined;
  private outcome: TaskProgressOutcome | undefined;
  private touched = false;
  private dead = false;
  private readonly api: Api;
  private readonly chatId: number;
  private readonly topic: number | undefined;
  private readonly replyParameters: ReplyParameters | undefined;

  constructor(api: Api, chatId: number, topic?: number, replyParameters?: ReplyParameters) {
    this.api = api;
    this.chatId = chatId;
    this.topic = topic;
    this.replyParameters = replyParameters;
  }

  update(event: TaskActivityEvent): void {
    if (this.dead || this.outcome) return;
    this.touched = true;
    if (event.kind === "plan") {
      this.plan.clear();
      for (const task of event.tasks) this.plan.set(task.id, task);
    } else {
      const previous = this.agents.get(event.task.id);
      this.agents.set(event.task.id, previous ? { ...previous, ...event.task } : event.task);
    }
    this.schedule();
  }

  async finish(outcome: TaskProgressOutcome): Promise<void> {
    if (!this.touched || this.dead) return;
    this.outcome = outcome;
    if (outcome !== "completed") {
      const terminal = outcome === "failed" ? "failed" : "stopped";
      for (const [id, task] of this.agents) {
        if (task.status === "running") this.agents.set(id, { ...task, status: terminal });
      }
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.queueRender();
  }

  cancel(): void {
    this.dead = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastSentAt;
    const delay = this.lastSentAt === 0 ? FIRST_RENDER_DELAY_MS : Math.max(0, THROTTLE_MS - elapsed);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.queueRender();
    }, delay);
  }

  private queueRender(): Promise<void> {
    let text = renderTaskActivity([...this.plan.values()], [...this.agents.values()], this.outcome);
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
      log.warn(`task progress disabled for chat ${this.chatId}: ${error}`);
    }
  }
}

export function renderTaskActivity(
  plan: readonly TaskActivityItem[],
  agents: readonly TaskActivityItem[],
  outcome?: TaskProgressOutcome,
): string {
  const header = outcome === "failed"
    ? "❌ Turno encerrado com erro"
    : outcome === "stopped"
      ? "⏹ Turno interrompido"
      : outcome === "completed"
        ? "✅ Turno concluído"
        : "⚙️ Claude trabalhando";
  if (!plan.length && !agents.length) return outcome ? header : "";
  const sections = [header];
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
  return `${Math.round(milliseconds / 1_000)}s`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `${tokens} tok`;
}

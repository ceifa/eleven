import type { Api } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import { PanelBoard, type Panel, type PanelRow, type PanelRowState, type PanelUpdate } from "../../agent/panels.ts";
import { logger } from "../../log.ts";
import { isNoop, withRetry } from "./retry.ts";

const log = logger("telegram/status");
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
// Spacing between edits of the status card. A DM tolerates roughly one message
// per second; a group is flood-limited at about twenty per minute, and going
// faster earns a 429 that stalls everything else queued for that chat.
const THROTTLE_MS = 900;
const GROUP_THROTTLE_MS = 3_000;
const MAX_PANEL_ROWS = 12;
const MAX_TEXT = 4_000;

/** When each group last had its status card written to. A group's flood limit is
 * per chat, not per turn: two turns running in the same group each kept their own
 * cadence, doubled the rate, and tripped it. One budget, shared.
 *
 * Groups only — a DM's limit is per user and looser, and the API throttler
 * already spaces those out on its own. */
const lastGroupEditAt = new Map<number, number>();

export type TurnOutcome = "completed" | "failed" | "stopped";

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

export interface TurnStatusOptions {
  topic?: number;
  replyParameters?: ReplyParameters;
  /** Spacing between edits; defaults to what the chat kind tolerates. */
  throttleMs?: number;
  /** Hold-off before a tool-status-only message appears. */
  toolRenderDelayMs?: number;
  /** Hold-off before an event-less turn reports that it is working. */
  idleRenderDelayMs?: number;
}

/** One quiet, editable Telegram message for a turn's panels, the top-level tool
 * currently running, and provider retries. Panels and retries are a durable
 * record of the turn; a message that only ever showed tool status is deleted
 * when the turn ends — the reply (or failure notice) that follows supersedes it. */
export class TelegramTurnStatus {
  private readonly board = new PanelBoard();
  /** Tools whose own rows are on screen — their argument preview adds nothing. */
  private readonly reporting = new Set<string>();
  private readonly startedAt = Date.now();
  private currentTool: RunningStatus["tool"];
  private currentRetry: RetryStatus | undefined;
  private messageId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private lastSentAt = 0;
  private lastText = "";
  private pendingText: string | undefined;
  private draining: Promise<void> | undefined;
  private outcome: TurnOutcome | undefined;
  private dead = false;
  private readonly api: Api;
  private readonly chatId: number;
  private readonly topic: number | undefined;
  private readonly replyParameters: ReplyParameters | undefined;
  private readonly throttleMs: number;
  private readonly toolRenderDelayMs: number;
  private readonly idleRenderDelayMs: number;

  constructor(api: Api, chatId: number, options: TurnStatusOptions = {}) {
    this.api = api;
    this.chatId = chatId;
    this.topic = options.topic;
    this.replyParameters = options.replyParameters;
    // Telegram ids tell the two apart: a private chat's id is the user's own and
    // is positive, groups and channels are negative.
    this.throttleMs = options.throttleMs ?? (chatId < 0 ? GROUP_THROTTLE_MS : THROTTLE_MS);
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

  panels(update: PanelUpdate): void {
    if (this.dead || this.outcome) return;
    this.board.apply(update);
    // A tool that publishes its own panels has just said more than its
    // arguments ever could — the "🔧 workflow · script: export const meta…"
    // line over a live phase list is noise.
    if (update.tool) {
      this.reporting.add(update.tool);
      if (this.currentTool?.name === update.tool) this.currentTool = undefined;
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

  async finish(outcome: TurnOutcome): Promise<void> {
    if (this.dead || this.outcome) return;
    if (!this.worthKeeping) {
      // Tool-status-only message: the reply (or failure notice) that follows
      // supersedes it. Clean up off the reply's critical path — the delete's
      // outcome affects nothing downstream.
      this.cancel();
      void Promise.resolve(this.draining).then(() => {
        if (!this.posted) return;
        return withRetry("idempotent", "delete turn status", () =>
          this.api.raw.deleteMessage({ chat_id: this.chatId, message_id: this.messageId! }),
        );
      }).catch((error) => {
        if (!isNoop(error)) log.warn(`status cleanup failed for chat ${this.chatId}: ${error}`);
      });
      return;
    }
    this.stopTimers();
    this.outcome = outcome;
    if (outcome !== "completed") this.board.settle();
    await this.queueRender();
  }

  cancel(): void {
    this.dead = true;
    this.stopTimers();
  }

  /** Panels and retries outlive the turn; bare tool status does not. */
  private get worthKeeping(): boolean {
    return this.board.changed || !!this.currentRetry;
  }

  /** The status message exists in the chat. */
  private get posted(): boolean {
    return this.messageId !== undefined;
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
    const hold = this.board.changed || this.currentRetry
      ? FIRST_RENDER_DELAY_MS
      : this.currentTool
        ? this.toolRenderDelayMs
        : this.idleRenderDelayMs;
    // An infinite hold-off means this kind of content never earns a message of
    // its own; richer content re-arms with a finite one.
    if (!this.posted && !Number.isFinite(hold)) return;
    const delay = this.lastSentAt
      ? Math.max(0, this.throttleMs - (Date.now() - this.lastSentAt))
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
    const text = renderTurnStatus(this.board.panels, this.outcome, running, this.currentRetry);
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
        // Wait out whichever came last: this card's own edit or another turn's
        // in the same group.
        const floor = Math.max(this.lastSentAt, lastGroupEditAt.get(this.chatId) ?? 0);
        const wait = floor ? Math.max(0, floor + this.throttleMs - Date.now()) : 0;
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (this.dead) return;
        if (!this.posted) await this.post(text);
        else await this.repost(text);
        this.lastText = text;
        this.lastSentAt = Date.now();
        if (this.chatId < 0) lastGroupEditAt.set(this.chatId, this.lastSentAt);
      }
    } catch (error) {
      this.dead = true;
      this.stopTimers();
      log.warn(`turn status disabled for chat ${this.chatId}: ${error}`);
    }
  }

  /** First render: post the message. */
  private async post(text: string): Promise<void> {
    const message = await withRetry("send", "send turn status", () =>
      this.api.raw.sendMessage({
        chat_id: this.chatId,
        message_thread_id: this.topic,
        text,
        reply_parameters: this.replyParameters,
        disable_notification: true,
      }),
    );
    this.messageId = message.message_id;
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
      await withRetry("idempotent", "edit turn status", () =>
        this.api.raw.editMessageText({ chat_id: this.chatId, message_id: this.messageId!, text }),
      );
    } catch (error) {
      if (!isNoop(error)) throw error;
    }
  }
}

export function renderTurnStatus(
  panels: readonly Panel[],
  outcome?: TurnOutcome,
  running?: RunningStatus,
  retry?: RetryStatus,
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
  if (!panels.length) return outcome || running || retry ? head : "";
  const text = [head, ...panels.map(renderPanel)].join("\n\n");
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

/** Over the limit, finished rows give way first, oldest first, and are counted
 *  on one line: cutting the tail instead hid the work still in play behind
 *  "… N more" while a page of old ✅ stayed on screen. */
function renderPanel(panel: Panel): string {
  const title = panel.icon ? `${panel.icon} ${panel.title}` : panel.title;
  const more = panel.more ?? 0;
  if (panel.rows.length > MAX_PANEL_ROWS) {
    let hide = panel.rows.length - MAX_PANEL_ROWS + 1;
    const shown = panel.rows.filter((row) => row.state !== "done" || hide-- <= 0);
    const done = panel.rows.length - shown.length;
    if (done) return renderRows(`${title}\n✅ ${done} done`, shown, MAX_PANEL_ROWS - 1, more);
  }
  return renderRows(title, panel.rows, MAX_PANEL_ROWS, more);
}

/** `more` is what the producer left out, on top of what this cap hides: a
 *  count of the rows that arrived would understate a 40-agent fan-out as
 *  "… 2 more". */
function renderRows(title: string, rows: readonly PanelRow[], limit: number, more: number): string {
  const visible = rows.slice(0, limit).map(renderRow);
  const hidden = Math.max(0, rows.length - limit) + more;
  if (hidden > 0) visible.push(`… ${hidden} more`);
  return `${title}\n${visible.join("\n")}`;
}

function renderRow(row: PanelRow): string {
  return `${STATE_ICONS[row.state]} ${compact(row.text)}${row.note ? ` · ${compact(row.note, 90)}` : ""}`;
}

const STATE_ICONS: Record<PanelRowState, string> = {
  idle: "○",
  waiting: "⏸",
  active: "⏳",
  done: "✅",
  failed: "❌",
  stopped: "⏹",
};

function compact(value: string, limit = 120): string {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

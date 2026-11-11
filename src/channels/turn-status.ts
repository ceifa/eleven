import { PanelBoard, type Panel, type PanelRow, type PanelRowState, type PanelUpdate } from "../agent/panels.ts";
import type { BackgroundStatus } from "../agent/host-api.ts";
import { keyedLane } from "../util.ts";
import { logger } from "../log.ts";

const log = logger("status");
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
export const ELAPSED_MIN_MS = 10_000;
const MAX_PANEL_ROWS = 12;
const MAX_TEXT = 4_000;

/** When each rate-limited chat last had a status card written to. A flood limit
 * is per chat, not per turn: two turns running in the same group each kept their
 * own cadence, doubled the rate, and tripped it. One budget, shared. */
const lastEditAt = new Map<string, number>();
const editLanes = new Map<string, Promise<unknown>>();

/** Cards still drawing something, so a shutdown can settle them. */
const liveCards = new Set<TurnStatus<unknown>>();

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

/** Background work the turn started, drawn under the turn's own panels. */
export interface RunView {
  title: string;
  /** What its Stop button carries; the button goes once the run settles. */
  stopId: string;
  panels: readonly Panel[];
  outcome?: TurnOutcome;
  elapsedMs: number;
}

/** What a status card shows at one moment. `running` is set until the turn has
 *  an outcome; runs can outlive it. */
export interface StatusView {
  panels: readonly Panel[];
  outcome?: TurnOutcome;
  running?: RunningStatus;
  retry?: RetryStatus;
  elapsedMs?: number;
  runs?: readonly RunView[];
}

/** The one message a status card lives in, as a channel posts, edits and
 * deletes it. The surface remembers what it posted. */
export interface StatusSurface<R> {
  post(card: R): Promise<void>;
  edit(card: R): Promise<void>;
  remove(): Promise<void>;
}

export interface TurnStatusOptions<R> {
  /** The card for a view in the channel's own terms; undefined when there is
   *  nothing worth showing. */
  render: (view: StatusView) => R | undefined;
  /** Spacing between edits — what the chat tolerates. */
  throttleMs: number;
  /** Chats whose cards share one edit budget, because their flood limit is
   *  per chat; absent when nothing else writes against this card's limit. */
  rateKey?: string;
  /** Hold-off before a tool-status-only message appears. */
  toolRenderDelayMs?: number;
  /** Hold-off before an event-less turn reports that it is working. */
  idleRenderDelayMs?: number;
}

interface Run {
  title: string;
  stopId: string;
  board: PanelBoard;
  startedAt: number;
  endedAt?: number;
  outcome?: TurnOutcome;
}

/** One quiet, editable message for a turn's panels, the top-level tool
 * currently running, and provider retries. Panels and retries are a durable
 * record of the turn; a message that only ever showed tool status is deleted
 * when the turn ends — the reply (or failure notice) that follows supersedes it.
 *
 * Background runs the turn started draw here too, under the turn's own panels:
 * the card keeps updating after the turn is done, until every run settles. */
export class TurnStatus<R = string> {
  private readonly board = new PanelBoard();
  /** Tools whose own rows are on screen — their argument preview adds nothing. */
  private readonly reporting = new Set<string>();
  private readonly startedAt = Date.now();
  private currentTool: RunningStatus["tool"];
  private currentRetry: RetryStatus | undefined;
  private posted = false;
  private timer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private lastSentAt = 0;
  private lastKey = "";
  private pending: { card: R; key: string } | undefined;
  private draining: Promise<void> | undefined;
  private outcome: TurnOutcome | undefined;
  private dead = false;
  private readonly runs: Run[] = [];
  private readonly surface: StatusSurface<R>;
  private readonly render: (view: StatusView) => R | undefined;
  private readonly throttleMs: number;
  private readonly rateKey: string | undefined;
  private readonly toolRenderDelayMs: number;
  private readonly idleRenderDelayMs: number;

  constructor(surface: StatusSurface<R>, options: TurnStatusOptions<R>) {
    this.surface = surface;
    this.render = options.render;
    this.throttleMs = options.throttleMs;
    this.rateKey = options.rateKey;
    this.toolRenderDelayMs = options.toolRenderDelayMs ?? TOOL_FIRST_RENDER_DELAY_MS;
    this.idleRenderDelayMs = options.idleRenderDelayMs ?? IDLE_FIRST_RENDER_DELAY_MS;
    liveCards.add(this);
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

  /** Draw a background run this turn started. Its panels and outcome are its
   *  own: the turn ending, failing or being stopped settles none of it. */
  attach(title: string, stopId: string): BackgroundStatus {
    const run: Run = { title, stopId, board: new PanelBoard(), startedAt: Date.now() };
    this.runs.push(run);
    this.rearm();
    return {
      panels: (update) => {
        if (this.dead || run.outcome) return;
        run.board.apply(update);
        this.rearm();
      },
      finish: async (outcome) => {
        if (run.outcome) return;
        run.outcome = outcome;
        run.endedAt = Date.now();
        if (outcome !== "completed") run.board.settle();
        if (this.dead) return;
        if (!this.outcome) return this.rearm();
        if (!this.runsLive) this.stopTimers();
        await this.queueRender();
      },
    };
  }

  async finish(outcome: TurnOutcome): Promise<void> {
    if (this.dead || this.outcome) return;
    if (!this.worthKeeping) {
      // Tool-status-only message: the reply (or failure notice) that follows
      // supersedes it. Clean up off the reply's critical path — the delete's
      // outcome affects nothing downstream.
      this.cancel();
      void Promise.resolve(this.draining).then(() => {
        if (this.posted) return this.surface.remove();
      }).catch((error) => log.warn(`status cleanup failed: ${error}`));
      return;
    }
    // The elapsed ticker keeps running for the runs still on the card.
    this.outcome = outcome;
    if (!this.runsLive) this.stopTimers();
    if (outcome !== "completed") this.board.settle();
    await this.queueRender();
  }

  /** eleven is going down under a turn that will be woken in a new card: say
   *  so, rather than leave this one claiming to work forever. A card that only
   *  showed tool status goes; one with a record left on it says it stopped,
   *  along with the runs that die with the process. */
  async interrupt(): Promise<void> {
    if (!this.live) return;
    if (!this.outcome && !this.worthKeeping) {
      this.cancel();
      await this.draining;
      if (this.posted) await this.surface.remove();
      return;
    }
    for (const run of this.runs) {
      if (run.outcome) continue;
      run.outcome = "stopped";
      run.endedAt = Date.now();
      run.board.settle();
    }
    this.outcome ??= "stopped";
    this.board.settle();
    this.stopTimers();
    await this.queueRender();
  }

  /** The turn is over. A card still drawing runs stays live until they settle. */
  cancel(): void {
    if (this.outcome && this.runsLive) return;
    this.dead = true;
    this.stopTimers();
  }

  /** Panels, retries and runs outlive the turn; bare tool status does not. */
  private get worthKeeping(): boolean {
    return this.board.changed || !!this.currentRetry || this.runs.length > 0;
  }

  private get runsLive(): boolean {
    return this.runs.some((run) => !run.outcome);
  }

  /** Something on the card is still moving. */
  private get live(): boolean {
    return !this.dead && (!this.outcome || this.runsLive);
  }

  private stopTimers(): void {
    if (!this.live) liveCards.delete(this);
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
    if (this.timer || !this.live) return;
    const hold = this.board.changed || this.currentRetry || this.runs.length
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
    const now = Date.now();
    const runs = this.runs.map((run): RunView => ({
      title: run.title,
      stopId: run.stopId,
      panels: run.board.panels,
      outcome: run.outcome,
      elapsedMs: (run.endedAt ?? now) - run.startedAt,
    }));
    const card = this.render({
      panels: this.board.panels,
      outcome: this.outcome,
      running,
      retry: this.currentRetry,
      elapsedMs: now - this.startedAt,
      ...(runs.length ? { runs } : {}),
    });
    const key = typeof card === "string" ? card : JSON.stringify(card);
    if (card === undefined || key === this.lastKey || key === this.pending?.key || this.dead) return this.draining ?? Promise.resolve();
    this.pending = { card, key }; // latest wins while the chat is slow
    if (!this.draining) {
      this.draining = this.drain().finally(() => { this.draining = undefined; });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending && !this.dead) {
        const write = async () => {
          const floor = Math.max(this.lastSentAt, (this.rateKey && lastEditAt.get(this.rateKey)) || 0);
          const wait = floor ? Math.max(0, floor + this.throttleMs - Date.now()) : 0;
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
          if (this.dead || !this.pending) return;
          const { card, key } = this.pending;
          this.pending = undefined;
          if (!this.posted) await this.post(card);
          else await this.surface.edit(card);
          this.lastKey = key;
          this.lastSentAt = Date.now();
          if (this.rateKey) lastEditAt.set(this.rateKey, this.lastSentAt);
        };
        if (this.rateKey) await keyedLane(editLanes, this.rateKey, write);
        else await write();
      }
    } catch (error) {
      this.dead = true;
      this.stopTimers();
      log.warn(`turn status disabled: ${error}`);
    }
  }

  /** First render: post the message. */
  private async post(card: R): Promise<void> {
    await this.surface.post(card);
    this.posted = true;
    if (!this.live) return;
    // From here on the running header shows elapsed time — keep it honest
    // between events. queueRender directly: the tick always exceeds the
    // throttle, which drain() enforces anyway.
    this.ticker ??= setInterval(() => {
      if (this.live) void this.queueRender();
    }, ELAPSED_TICK_MS);
    this.ticker.unref();
  }
}

/** The card as plain text, for chats that draw nothing richer. */
export function plainStatus(view: StatusView): string | undefined {
  const turn = renderTurnStatus(view.panels, view.outcome, view.running, view.retry);
  const runs = (view.runs ?? []).map((run) => [runHeadline(run), ...run.panels.map((panel) => renderPanel(panel))].join("\n\n"));
  return clip([turn, ...runs].filter(Boolean).join("\n\n")) || undefined;
}

export const RUN_ICONS: Record<TurnOutcome | "running", string> = { running: "⚙️", completed: "✅", failed: "❌", stopped: "⏹" };

function runHeadline(run: RunView): string {
  return `${RUN_ICONS[run.outcome ?? "running"]} ${compact(run.title)} · ${run.outcome ?? "running"} · ${formatDuration(run.elapsedMs)}`;
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
  return renderStatusText(head, panels);
}

export function renderStatusText(header: string, panels: readonly Panel[]): string {
  return clip([header, ...panels.map((panel) => renderPanel(panel))].join("\n\n"));
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

/** How a panel's own words are written: as they are, or escaped and dressed
 *  for a chat that reads markdown. */
export interface PanelStyle {
  title: (title: string) => string;
  text: (text: string) => string;
}

const PLAIN: PanelStyle = { title: (title) => title, text: (text) => text };

/** Over the limit, finished rows give way first, oldest first, and are counted
 *  on one line: cutting the tail instead hid the work still in play behind
 *  "… N more" while a page of old ✅ stayed on screen. */
export function renderPanel(panel: Panel, style: PanelStyle = PLAIN): string {
  const title = style.title(panel.icon ? `${panel.icon} ${panel.title}` : panel.title);
  const more = panel.more ?? 0;
  if (panel.rows.length > MAX_PANEL_ROWS) {
    let hide = panel.rows.length - MAX_PANEL_ROWS + 1;
    const shown = panel.rows.filter((row) => row.state !== "done" || hide-- <= 0);
    const done = panel.rows.length - shown.length;
    if (done) return renderRows(`${title}\n✅ ${done} done`, shown, MAX_PANEL_ROWS - 1, more, style);
  }
  return renderRows(title, panel.rows, MAX_PANEL_ROWS, more, style);
}

/** `more` is what the producer left out, on top of what this cap hides: a
 *  count of the rows that arrived would understate a 40-agent fan-out as
 *  "… 2 more". */
function renderRows(title: string, rows: readonly PanelRow[], limit: number, more: number, style: PanelStyle): string {
  const visible = rows.slice(0, limit).map((row) => renderRow(row, style));
  const hidden = Math.max(0, rows.length - limit) + more;
  if (hidden > 0) visible.push(`… ${hidden} more`);
  return `${title}\n${visible.join("\n")}`;
}

function renderRow(row: PanelRow, style: PanelStyle): string {
  return `${STATE_ICONS[row.state]} ${style.text(compact(row.text))}${row.note ? ` · ${style.text(compact(row.note, 90))}` : ""}`;
}

const STATE_ICONS: Record<PanelRowState, string> = {
  idle: "○",
  waiting: "⏸",
  active: "⏳",
  done: "✅",
  failed: "❌",
  stopped: "⏹",
};

export function compact(value: string, limit = 120): string {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Settle every live card before eleven exits (see TurnStatus.interrupt). */
export async function interruptLiveCards(): Promise<void> {
  await Promise.allSettled([...liveCards].map((card) => card.interrupt()));
}

/**
 * What a turn shows besides its prose: panels a workspace extension or a tool
 * publishes while it works. eleven draws them and knows nothing else about
 * them. A panel is a titled list of rows, each in a state a channel turns into
 * an icon; whether the rows are a plan, a fan-out or a pipeline is the
 * producer's business, and so is everything that follows from that — which
 * rows are worth sending, what the note beside one says, how many were left out.
 */
export type PanelRowState = "idle" | "waiting" | "active" | "done" | "failed" | "stopped";

export interface PanelRow {
  text: string;
  state: PanelRowState;
  /** One line of context beside the text. */
  note?: string;
  /** Label/value pairs a channel may open on demand. */
  detail?: [string, string][];
}

export interface Panel {
  title: string;
  /** A glyph a channel may put before the title. */
  icon?: string;
  rows: PanelRow[];
  /** Rows the producer left out — a fan-out can have hundreds. Without it a
   *  channel counts the rows that arrived and says "… 2 more" when forty ran. */
  more?: number;
  /** Carried over rather than produced by this turn: drawn, but never the
   *  reason a channel posts a status message of its own. */
  quiet?: boolean;
}

/**
 * Everything one producer currently shows. Authoritative over its own scope
 * and nothing else: a turn can have several producers (an extension's plan,
 * every tool call reporting its phases), and the first to report must not wipe
 * the others off the screen.
 */
export interface PanelUpdate {
  scope: string;
  /** The tool that reported it, when a tool did — its rows already say more
   *  than its argument preview could. */
  tool?: string;
  panels: Panel[];
}

/** A turn's panels, every producer's in the order they first reported. */
export class PanelBoard {
  private readonly scopes = new Map<string, Panel[]>();
  private touched = false;

  apply(update: PanelUpdate): void {
    this.scopes.set(update.scope, update.panels);
    if (update.panels.some((panel) => !panel.quiet)) this.touched = true;
  }

  /** The turn is over without finishing: nothing on it is still being worked
   *  on, and a spinner that never resolves is worse than a row that says it was
   *  cut off. The producer may be the thing that died, so this can't be its job. */
  settle(): void {
    for (const [scope, panels] of this.scopes) {
      this.scopes.set(scope, panels.map((panel) => ({
        ...panel,
        rows: panel.rows.map((row) => (row.state === "active" ? { ...row, state: "stopped" } : row)),
      })));
    }
  }

  /** The panels worth drawing — an empty one is a producer clearing its rows. */
  get panels(): Panel[] {
    return [...this.scopes.values()].flat().filter((panel) => panel.rows.length || panel.more);
  }

  /** Did this turn produce any of it, rather than only carry it over? */
  get changed(): boolean {
    return this.touched;
  }
}

/**
 * Panels a tool attached to a partial result. Any tool speaks this through the
 * `onUpdate` callback of `execute`: pi's loop turns it into
 * `tool_execution_update`, and the MCP bridge forwards it directly.
 */
export function readToolPanels(partialResult: unknown, scope: string, tool: string): PanelUpdate | undefined {
  return readPanels(asRecord(asRecord(partialResult).details).panels, scope, tool);
}

/**
 * Validate panels on their way in. They cross a tool boundary (and, for MCP, a
 * transport), so nothing about their shape is guaranteed: anything malformed
 * is dropped rather than thrown, because reporting progress must never fail
 * the thing reporting it. Anything but an array is no report at all; an empty
 * array clears the producer's panels.
 */
export function readPanels(raw: unknown, scope: string, tool?: string): PanelUpdate | undefined {
  if (!Array.isArray(raw)) return undefined;
  const panels = raw.map((entry) => readPanel(entry, tool ?? scope)).filter((panel): panel is Panel => !!panel);
  return { scope, ...(tool ? { tool } : {}), panels };
}

const STATES = new Set<string>(["idle", "waiting", "active", "done", "failed", "stopped"]);

function readPanel(value: unknown, fallbackTitle: string): Panel | undefined {
  const raw = asRecord(value);
  if (!Array.isArray(raw.rows)) return undefined;
  const icon = readString(raw.icon);
  const more = typeof raw.more === "number" && raw.more > 0 ? Math.floor(raw.more) : 0;
  return {
    title: readString(raw.title) ?? fallbackTitle,
    ...(icon ? { icon } : {}),
    rows: raw.rows.map(readRow).filter((row): row is PanelRow => !!row),
    ...(more ? { more } : {}),
    ...(raw.quiet === true ? { quiet: true } : {}),
  };
}

function readRow(value: unknown): PanelRow | undefined {
  const raw = asRecord(value);
  const text = readString(raw.text);
  if (!text) return undefined;
  const note = readString(raw.note);
  const detail = Array.isArray(raw.detail)
    ? raw.detail.filter((pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")
    : [];
  return {
    text,
    // A row that says nothing about its state is one somebody is working on.
    state: typeof raw.state === "string" && STATES.has(raw.state) ? (raw.state as PanelRowState) : "active",
    ...(note ? { note } : {}),
    ...(detail.length ? { detail } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

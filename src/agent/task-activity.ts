export type TaskActivityStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface TaskActivityUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface TaskActivityItem {
  id: string;
  title: string;
  status: TaskActivityStatus;
  blockedBy?: string[];
  summary?: string;
  lastToolName?: string;
  taskType?: string;
  subagentType?: string;
  usage?: TaskActivityUsage;
}

/** Provider-neutral task activity. Plans are authoritative snapshots; agent
 * events are incremental updates keyed by task id.
 *
 * `scope` names the producer. A turn can have more than one (the session's own
 * plan, plus any number of tools reporting their internal phases), and a
 * snapshot is authoritative only over the rows of its own scope — without it,
 * the first tool to report would wipe the session plan off the screen. The
 * session's own plan is the unscoped one; `label` is how a scope is named on
 * screen, so a tool's phases read as the tool's and not as the user's plan. */
export type TaskActivityEvent =
  | {
    kind: "plan";
    scope?: string;
    label?: string;
    tasks: TaskActivityItem[];
    /** Carried over from a previous turn rather than produced by this one. It
     *  is context: it may be drawn, but it never justifies a status message of
     *  its own, and it does not make one worth keeping. */
    seeded?: boolean;
  }
  | { kind: "agent"; task: TaskActivityItem }
  /** How many agents a scope actually has. A producer that caps the rows it
   *  sends (a fan-out can spawn hundreds) has to say so, or "… N more" counts
   *  the rows that arrived instead of the ones that exist — and lies. */
  | { kind: "agents"; scope?: string; total: number };

/** A named group of plan rows: the session's own (no label) or one tool's. */
export interface TaskActivitySection {
  label?: string;
  tasks: TaskActivityItem[];
}

/**
 * A turn's task activity, folded into the two lists every surface draws. One
 * implementation because both surfaces have the same three subtleties: a plan
 * snapshot replaces only its own scope, agent events merge into the row they
 * name, and a turn that ends badly has to terminate the rows still marked
 * running (nobody is left to report them).
 */
export class TaskActivityBoard {
  private readonly planRows = new Map<string, { task: TaskActivityItem; scope?: string }>();
  private readonly agentRows = new Map<string, TaskActivityItem>();
  /** Display name per scope, from whichever event last named it. */
  private readonly labels = new Map<string, string>();
  /** Agents a scope says it has, which can exceed the rows it sent. */
  private readonly totals = new Map<string, number>();
  /** Something in this turn changed the board — as opposed to a plan seeded
   *  from a previous one, which is context and shouldn't earn a message. */
  private touched = false;

  apply(event: TaskActivityEvent): void {
    if (event.kind === "agents") {
      this.totals.set(event.scope ?? "", event.total);
      this.touched = true;
      return;
    }
    if (event.kind === "plan") {
      if (event.label) this.labels.set(event.scope ?? "", event.label);
      for (const [id, row] of this.planRows) {
        if (row.scope === event.scope) this.planRows.delete(id);
      }
      for (const task of event.tasks) this.planRows.set(task.id, { task, scope: event.scope });
      if (!event.seeded) this.touched = true;
      return;
    }
    const previous = this.agentRows.get(event.task.id);
    this.agentRows.set(event.task.id, previous ? { ...previous, ...event.task } : event.task);
    this.touched = true;
  }

  /** The turn stopped or failed: whatever was still running, isn't. */
  settle(status: Extract<TaskActivityStatus, "failed" | "stopped">): void {
    for (const [id, task] of this.agentRows) {
      if (task.status === "running") this.agentRows.set(id, { ...task, status });
    }
  }

  /** Plan rows grouped by producer, the session's own first. A tool's phases
   *  are its own list: merged into one, a reader cannot tell the work they
   *  asked for from a tool's internal bookkeeping. */
  get sections(): TaskActivitySection[] {
    const groups = new Map<string, TaskActivityItem[]>();
    for (const { task, scope } of this.planRows.values()) {
      const key = scope ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(task);
    }
    const own = groups.get("");
    groups.delete("");
    return [
      ...(own ? [{ tasks: own }] : []),
      ...[...groups].map(([key, tasks]) => ({ label: this.labels.get(key) ?? key, tasks })),
    ];
  }

  get plan(): TaskActivityItem[] {
    return [...this.planRows.values()].map((row) => row.task);
  }

  get agents(): TaskActivityItem[] {
    return [...this.agentRows.values()];
  }

  /** How many agents exist, not how many rows arrived. */
  get agentTotal(): number {
    const reported = [...this.totals.values()].reduce((sum, total) => sum + total, 0);
    return Math.max(this.agentRows.size, reported);
  }

  get empty(): boolean {
    return !this.planRows.size && !this.agentRows.size;
  }

  /** Did this turn actually produce any of it? */
  get changed(): boolean {
    return this.touched;
  }
}

/**
 * What a tool attaches to a partial result to report progress. Any tool — a
 * workspace extension, a channel tool — speaks this and reaches the same
 * renderer the runtime's own plan/agent events do; eleven never learns what the
 * tool is. Reported through the `onUpdate` callback of `execute`, which the pi
 * loop turns into `tool_execution_update` and the MCP bridge forwards directly.
 */
export interface ToolActivityDetails {
  activity?: TaskActivityEvent[];
}

const STATUSES = new Set<string>(["pending", "running", "completed", "failed", "stopped"]);

/**
 * Read task activity out of a tool's partial result, defensively: the payload
 * crosses a tool boundary (and, for MCP, a transport), so nothing about its
 * shape is guaranteed. Anything malformed is dropped rather than thrown —
 * progress reporting must never be able to fail a tool call.
 *
 * Ids are namespaced with `scope` so a tool's rows can never collide with the
 * session's own task ids, and so a tool's plan snapshot only ever replaces its
 * own rows. `label` is the tool's name — how the scope is titled on screen.
 */
export function readToolActivity(partialResult: unknown, scope: string, label?: string): TaskActivityEvent[] {
  const details = (asRecord(partialResult).details ?? {}) as Record<string, unknown>;
  const raw = details.activity;
  if (!Array.isArray(raw)) return [];
  const events: TaskActivityEvent[] = [];
  for (const entry of raw) {
    const event = asRecord(entry);
    if (event.kind === "plan") {
      if (!Array.isArray(event.tasks)) continue;
      const tasks = event.tasks.map((task) => readItem(task, scope)).filter((task): task is TaskActivityItem => !!task);
      events.push({ kind: "plan", scope, tasks, ...(label ? { label } : {}) });
    } else if (event.kind === "agent") {
      const task = readItem(event.task, scope);
      if (task) events.push({ kind: "agent", task });
    } else if (event.kind === "agents") {
      // A cap the producer applied to itself. Without the count it reports, the
      // renderers would describe the rows they got as if they were all there is.
      if (typeof event.total === "number" && event.total >= 0) {
        events.push({ kind: "agents", scope, total: Math.floor(event.total) });
      }
    }
  }
  return events;
}

/** A row's id without its scope prefix — ids are namespaced for correctness,
 *  but "blocked by #call-7:p1" is not something anyone should have to read. */
export function displayId(id: string): string {
  const colon = id.lastIndexOf(":");
  return colon === -1 ? id : id.slice(colon + 1);
}

function readItem(value: unknown, scope: string): TaskActivityItem | undefined {
  const raw = asRecord(value);
  const id = readString(raw.id);
  const title = readString(raw.title);
  if (!id || !title) return undefined;
  const blockedBy = Array.isArray(raw.blockedBy)
    ? raw.blockedBy.map(readString).filter((entry): entry is string => !!entry).map((entry) => qualify(entry, scope))
    : undefined;
  return {
    id: qualify(id, scope),
    title,
    status: typeof raw.status === "string" && STATUSES.has(raw.status) ? (raw.status as TaskActivityStatus) : "running",
    ...(blockedBy?.length ? { blockedBy } : {}),
    ...(readString(raw.summary) ? { summary: readString(raw.summary) } : {}),
    ...(readString(raw.lastToolName) ? { lastToolName: readString(raw.lastToolName) } : {}),
    ...(readString(raw.taskType) ? { taskType: readString(raw.taskType) } : {}),
    ...(readString(raw.subagentType) ? { subagentType: readString(raw.subagentType) } : {}),
    ...(readUsage(raw.usage) ? { usage: readUsage(raw.usage) } : {}),
  };
}

/** Already-qualified ids pass through, so a tool may report the id it was given back. */
function qualify(id: string, scope: string): string {
  return id.startsWith(`${scope}:`) ? id : `${scope}:${id}`;
}

function readUsage(value: unknown): TaskActivityUsage | undefined {
  const raw = asRecord(value);
  const usage: TaskActivityUsage = {
    ...(typeof raw.totalTokens === "number" ? { totalTokens: raw.totalTokens } : {}),
    ...(typeof raw.toolUses === "number" ? { toolUses: raw.toolUses } : {}),
    ...(typeof raw.durationMs === "number" ? { durationMs: raw.durationMs } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

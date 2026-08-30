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
 * `scope` names the producer of a plan snapshot. A turn can have more than one
 * (the session's own plan, plus a tool reporting its internal phases), and a
 * snapshot is authoritative only over the rows of its own scope — without it,
 * the first tool to report would wipe the session plan off the screen. The
 * session's own plan is the unscoped one. */
export type TaskActivityEvent =
  | { kind: "plan"; scope?: string; tasks: TaskActivityItem[] }
  | { kind: "agent"; task: TaskActivityItem };

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
 * own rows.
 */
export function readToolActivity(partialResult: unknown, scope: string): TaskActivityEvent[] {
  const details = (asRecord(partialResult).details ?? {}) as Record<string, unknown>;
  const raw = details.activity;
  if (!Array.isArray(raw)) return [];
  const events: TaskActivityEvent[] = [];
  for (const entry of raw) {
    const event = asRecord(entry);
    if (event.kind === "plan") {
      if (!Array.isArray(event.tasks)) continue;
      const tasks = event.tasks.map((task) => readItem(task, scope)).filter((task): task is TaskActivityItem => !!task);
      events.push({ kind: "plan", scope, tasks });
    } else if (event.kind === "agent") {
      const task = readItem(event.task, scope);
      if (task) events.push({ kind: "agent", task });
    }
  }
  return events;
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

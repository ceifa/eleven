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
 * events are incremental updates keyed by task id. */
export type TaskActivityEvent =
  | { kind: "plan"; tasks: TaskActivityItem[] }
  | { kind: "agent"; task: TaskActivityItem };

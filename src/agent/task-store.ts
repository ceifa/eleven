import { join } from "node:path";
import { rm } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "../util.ts";
import type { TaskActivityEvent, TaskActivityItem } from "./task-activity.ts";

/**
 * The turn's plan, owned by eleven rather than by whatever runtime is driving
 * the turn.
 *
 * It used to live inside the Claude Code CLI: eleven mirrored it by parsing
 * tool results, which meant no plan at all on any other provider, and a mirror
 * that died with the daemon. Here the tool call *is* the event, every provider
 * gets the same four tools, and the plan survives a restart.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  metadata?: Record<string, unknown>;
  /** Tasks that cannot start until this one completes. */
  blocks: string[];
  /** Tasks that must complete before this one can start. */
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

interface Persisted {
  nextId: number;
  tasks: TaskRecord[];
}

/** What TaskList hands back: enough to choose what to work on, no descriptions. */
export interface TaskSummary {
  id: string;
  subject: string;
  status: TaskStatus;
  owner: string;
  /** Open dependencies only — a completed blocker no longer blocks anything. */
  blockedBy: string[];
}

export class TaskStore {
  private readonly file: string;
  private state: Persisted;
  private listener: ((event: TaskActivityEvent) => void) | undefined;

  constructor(file: string) {
    this.file = file;
    this.state = readJsonFile<Persisted>(file, { nextId: 1, tasks: [] });
  }

  /** Where the turn's progress goes while a turn is running. */
  listen(listener: ((event: TaskActivityEvent) => void) | undefined): void {
    this.listener = listener;
  }

  list(): TaskSummary[] {
    return this.state.tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner ?? "",
      blockedBy: this.openBlockers(task),
    }));
  }

  get(id: string): TaskRecord | undefined {
    return this.state.tasks.find((task) => task.id === id);
  }

  create(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): TaskRecord {
    const now = Date.now();
    const task: TaskRecord = {
      id: String(this.state.nextId++),
      subject: input.subject,
      description: input.description,
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      status: "pending",
      ...(input.metadata ? { metadata: input.metadata } : {}),
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    this.commit();
    return task;
  }

  /** Apply an update. Returns undefined when the task is gone; `null` when it
   *  was deleted by this call (so the caller can say so). */
  update(id: string, patch: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): TaskRecord | null | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    if (patch.status === "deleted") {
      this.state.tasks = this.state.tasks.filter((entry) => entry.id !== id);
      // A dangling dependency would block its dependents forever.
      for (const entry of this.state.tasks) {
        entry.blocks = entry.blocks.filter((ref) => ref !== id);
        entry.blockedBy = entry.blockedBy.filter((ref) => ref !== id);
      }
      this.commit();
      return null;
    }
    if (patch.status) task.status = patch.status;
    if (patch.subject) task.subject = patch.subject;
    if (patch.description) task.description = patch.description;
    if (patch.activeForm) task.activeForm = patch.activeForm;
    if (patch.owner !== undefined) task.owner = patch.owner || undefined;
    if (patch.metadata) {
      const merged = { ...task.metadata, ...patch.metadata };
      // A null value deletes the key, so metadata can be cleared as well as set.
      for (const [key, value] of Object.entries(patch.metadata)) if (value === null) delete merged[key];
      task.metadata = Object.keys(merged).length ? merged : undefined;
    }
    for (const other of patch.addBlockedBy ?? []) this.link(other, task);
    for (const other of patch.addBlocks ?? []) {
      const blocked = this.get(other);
      if (blocked) this.link(task.id, blocked);
    }
    task.updatedAt = Date.now();
    this.commit();
    return task;
  }

  /** Record that `blockerId` must complete before `task` can start. Both sides
   *  of the edge are stored, so neither task has to be re-read to see it. */
  private link(blockerId: string, task: TaskRecord): void {
    const blocker = this.get(blockerId);
    if (!blocker || blocker.id === task.id) return;
    if (!task.blockedBy.includes(blocker.id)) task.blockedBy.push(blocker.id);
    if (!blocker.blocks.includes(task.id)) blocker.blocks.push(task.id);
  }

  private commit(): void {
    writeJsonFile(this.file, this.state);
    this.listener?.(this.snapshot());
  }

  /** Work this plan is still carrying. A plan that is entirely done is history:
   *  it should not follow the conversation into every later turn. */
  get unfinished(): boolean {
    return this.state.tasks.some((task) => task.status !== "completed");
  }

  /** The plan as the channels render it. Unscoped: this *is* the session's plan,
   *  as opposed to a tool reporting its own internal phases. */
  snapshot(seeded = false): TaskActivityEvent {
    return {
      kind: "plan",
      ...(seeded ? { seeded: true } : {}),
      tasks: this.state.tasks.map((task): TaskActivityItem => {
        const blockedBy = this.openBlockers(task);
        return {
          id: task.id,
          title: task.subject,
          status: task.status === "completed" ? "completed" : task.status === "in_progress" ? "running" : "pending",
          ...(blockedBy.length ? { blockedBy } : {}),
        };
      }),
    };
  }

  /** A completed blocker no longer blocks anything. */
  private openBlockers(task: TaskRecord): string[] {
    return task.blockedBy.filter((id) => this.get(id)?.status !== "completed");
  }
}

// One store per thread, kept alive between turns so the tools built on it stay
// identity-stable (the runner reuses a warm session only while its custom tools
// are the same objects).
const stores = new Map<string, TaskStore>();
const MAX_STORES = 256;

export function taskStoreFile(sessionDir: string, threadId: string): string {
  return join(sessionDir, "tasks", `${threadId}.json`);
}

export function taskStore(sessionDir: string, threadId: string): TaskStore {
  let store = stores.get(threadId);
  if (!store) {
    store = new TaskStore(taskStoreFile(sessionDir, threadId));
    stores.set(threadId, store);
    if (stores.size > MAX_STORES) stores.delete(stores.keys().next().value!);
  }
  return store;
}

/** Forget a thread's plan, on disk and in memory (thread deletion). */
export async function deleteTaskStore(sessionDir: string, threadId: string): Promise<void> {
  stores.delete(threadId);
  await rm(taskStoreFile(sessionDir, threadId), { force: true });
}

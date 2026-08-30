import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { taskStore, type TaskStatus, type TaskStore } from "./task-store.ts";

/**
 * The plan tools, provider-neutral. Same four verbs Claude Code offers
 * natively, but backed by eleven's own store — so a pi session gets a plan too,
 * it survives a daemon restart, and its updates reach the channel as the tool
 * call happens instead of being parsed back out of a runtime's tool results.
 *
 * Native subagents see them: SDK-MCP tools registered with `alwaysLoad` are
 * carried into a spawned agent's tool set (measured, not assumed).
 */

const STATUS = ["pending", "in_progress", "completed"] as const;

const ok = (text: string, details: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { success: false },
  isError: true,
});

function createTool(store: TaskStore): ToolDefinition {
  return defineTool({
    name: "TaskCreate",
    label: "Task Create",
    description:
      "Add a task to this conversation's plan. Use for work of three or more real steps, or when the user hands you a list — "
      + "not for a single trivial action. Tasks are created pending; claim one with TaskUpdate before starting it.",
    promptSnippet: "Add a task to the plan",
    parameters: Type.Object({
      subject: Type.String({ description: "Brief imperative title, e.g. \"Fix the login redirect\"" }),
      description: Type.String({ description: "What needs to be done, with the context needed to do it" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous shown while it runs, e.g. \"Fixing the login redirect\"" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata to attach" })),
    }),
    async execute(_id, params) {
      const task = store.create(params);
      return ok(`Task #${task.id} created: ${task.subject}`, { success: true, task });
    },
  }) as ToolDefinition;
}

function listTool(store: TaskStore): ToolDefinition {
  return defineTool({
    name: "TaskList",
    label: "Task List",
    description:
      "The whole plan in summary form: id, subject, status, owner, and open blockers. "
      + "Read it to pick up the next available task (pending, unowned, unblocked) or to check progress.",
    promptSnippet: "Read the plan",
    parameters: Type.Object({}),
    async execute() {
      const tasks = store.list();
      if (!tasks.length) return ok("The plan is empty.", { success: true, tasks });
      const lines = tasks.map((task) => {
        const blocked = task.blockedBy.length ? ` · blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
        return `#${task.id} [${task.status}]${task.owner ? ` (${task.owner})` : ""} ${task.subject}${blocked}`;
      });
      return ok(lines.join("\n"), { success: true, tasks });
    },
  }) as ToolDefinition;
}

function getTool(store: TaskStore): ToolDefinition {
  return defineTool({
    name: "TaskGet",
    label: "Task Get",
    description: "One task in full: description, status, owner, metadata, and both directions of its dependencies.",
    promptSnippet: "Read one task in full",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task id, as shown by TaskList" }),
    }),
    async execute(_id, params) {
      const task = store.get(params.taskId);
      if (!task) return fail(`No task #${params.taskId}.`);
      return ok(JSON.stringify(task, null, 2), { success: true, task });
    },
  }) as ToolDefinition;
}

function updateTool(store: TaskStore): ToolDefinition {
  return defineTool({
    name: "TaskUpdate",
    label: "Task Update",
    description:
      "Change a task: set it in_progress when you start, completed when it is actually done, or \"deleted\" to drop it. "
      + "Only mark completed when the work is finished — a partial implementation, a failing test or an unresolved error stays in_progress. "
      + "Also sets owner, text, metadata (a null value deletes a key) and dependencies.",
    promptSnippet: "Update a task",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task id" }),
      status: Type.Optional(Type.Union(
        [...STATUS.map((value) => Type.Literal(value)), Type.Literal("deleted")],
        { description: "pending → in_progress → completed, or deleted to remove it" },
      )),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      activeForm: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String({ description: "Who is working on it; empty string releases it" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task ids that cannot start until this one completes" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete before this one can start" })),
    }),
    async execute(_id, params) {
      const { taskId, ...patch } = params;
      const task = store.update(taskId, patch as { status?: TaskStatus | "deleted" });
      if (task === undefined) return fail(`No task #${taskId}.`);
      if (task === null) return ok(`Task #${taskId} deleted.`, { success: true, taskId });
      return ok(`Task #${task.id} is now ${task.status}.`, { success: true, task });
    },
  }) as ToolDefinition;
}

// Tool objects must be identity-stable across turns: the runner only reuses a
// thread's warm session while its custom tools are literally the same objects.
const cache = new Map<string, ToolDefinition[]>();
const MAX_CACHED = 256;

export function taskTools(sessionDir: string, threadId: string): ToolDefinition[] {
  let tools = cache.get(threadId);
  if (!tools) {
    const store = taskStore(sessionDir, threadId);
    tools = [createTool(store), listTool(store), getTool(store), updateTool(store)];
    cache.set(threadId, tools);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return tools;
}

export function forgetTaskTools(threadId: string): void {
  cache.delete(threadId);
}

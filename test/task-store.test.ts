import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, taskStoreFile } from "../src/agent/task-store.ts";
import { forgetTaskTools, taskTools } from "../src/agent/task-tools.ts";
import type { TaskActivityEvent } from "../src/agent/task-activity.ts";

const freshFile = () => join(mkdtempSync(join(tmpdir(), "eleven-tasks-")), "plan.json");

describe("TaskStore", () => {
  test("creates, claims and completes a task", () => {
    const store = new TaskStore(freshFile());
    const task = store.create({ subject: "Ship it", description: "the whole thing" });
    strictEqual(task.status, "pending");
    store.update(task.id, { owner: "agent", status: "in_progress" });
    deepStrictEqual(store.list(), [{ id: task.id, subject: "Ship it", status: "in_progress", owner: "agent", blockedBy: [] }]);
    store.update(task.id, { status: "completed" });
    strictEqual(store.get(task.id)?.status, "completed");
  });

  test("dependencies are stored on both sides and clear when the blocker completes", () => {
    const store = new TaskStore(freshFile());
    const first = store.create({ subject: "one", description: "" });
    const second = store.create({ subject: "two", description: "" });
    store.update(second.id, { addBlockedBy: [first.id] });

    deepStrictEqual(store.get(first.id)?.blocks, [second.id]);
    deepStrictEqual(store.list().find((t) => t.id === second.id)?.blockedBy, [first.id]);
    // A completed blocker stops blocking: the row is claimable again without
    // anyone having to edit the dependency away.
    store.update(first.id, { status: "completed" });
    deepStrictEqual(store.list().find((t) => t.id === second.id)?.blockedBy, []);
  });

  test("deleting a task takes its dangling edges with it", () => {
    const store = new TaskStore(freshFile());
    const blocker = store.create({ subject: "blocker", description: "" });
    const blocked = store.create({ subject: "blocked", description: "" });
    store.update(blocked.id, { addBlockedBy: [blocker.id] });
    strictEqual(store.update(blocker.id, { status: "deleted" }), null);
    // Otherwise the survivor waits forever on a task that no longer exists.
    deepStrictEqual(store.get(blocked.id)?.blockedBy, []);
  });

  test("a task cannot block itself", () => {
    const store = new TaskStore(freshFile());
    const task = store.create({ subject: "solo", description: "" });
    store.update(task.id, { addBlockedBy: [task.id] });
    deepStrictEqual(store.get(task.id)?.blockedBy, []);
  });

  test("metadata merges, and a null value deletes a key", () => {
    const store = new TaskStore(freshFile());
    const task = store.create({ subject: "s", description: "", metadata: { pr: 12, note: "keep" } });
    store.update(task.id, { metadata: { pr: null, extra: true } });
    deepStrictEqual(store.get(task.id)?.metadata, { note: "keep", extra: true });
  });

  test("an unknown task id is reported, not invented", () => {
    strictEqual(new TaskStore(freshFile()).update("404", { status: "completed" }), undefined);
  });

  test("the plan survives a restart", () => {
    // Regression: the plan lived in a process-memory Map inside the Claude
    // adapter and died with the daemon, so a restart mid-work lost it entirely.
    const file = freshFile();
    const first = new TaskStore(file);
    const task = first.create({ subject: "long job", description: "" });
    first.update(task.id, { status: "in_progress", owner: "agent" });

    const reopened = new TaskStore(file);
    deepStrictEqual(reopened.list(), [{ id: task.id, subject: "long job", status: "in_progress", owner: "agent", blockedBy: [] }]);
    // Ids keep counting from where they stopped, so a reused id can't collide.
    strictEqual(reopened.create({ subject: "next", description: "" }).id, String(Number(task.id) + 1));
  });

  test("every mutation reports the whole plan to the turn's listener", () => {
    const store = new TaskStore(freshFile());
    const seen: TaskActivityEvent[] = [];
    store.listen((event) => seen.push(event));
    const first = store.create({ subject: "one", description: "" });
    store.create({ subject: "two", description: "" });
    store.update(first.id, { status: "in_progress" });

    strictEqual(seen.length, 3);
    const last = seen.at(-1)!;
    ok(last.kind === "plan");
    // Unscoped: this is the session's own plan, not a tool's internal phases.
    strictEqual(last.scope, undefined);
    deepStrictEqual(last.tasks.map((t) => [t.title, t.status]), [["one", "running"], ["two", "pending"]]);

    store.listen(undefined);
    store.create({ subject: "three", description: "" });
    strictEqual(seen.length, 3);
  });
});

describe("task tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-tt-"));

  test("are the four verbs, on any provider", () => {
    deepStrictEqual(taskTools(dir, "thread-a").map((tool) => tool.name), ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
  });

  test("are identity-stable across turns", () => {
    // Regression risk: the runner reuses a thread's warm session only while its
    // custom tools are the same objects — rebuilding them per turn would pay a
    // cold start on every message.
    deepStrictEqual(taskTools(dir, "thread-b")[0] === taskTools(dir, "thread-b")[0], true);
    deepStrictEqual(taskTools(dir, "thread-b")[0] === taskTools(dir, "thread-c")[0], false);
    forgetTaskTools("thread-b");
    deepStrictEqual(taskTools(dir, "thread-b")[0] === taskTools(dir, "thread-c")[0], false);
  });

  test("each thread gets its own plan file", () => {
    match(taskStoreFile(dir, "thread-x"), /tasks\/thread-x\.json$/);
  });

  test("round-trip through the tools the model actually calls", async () => {
    const [create, list, get, update] = taskTools(dir, "thread-d");
    const created = await create.execute("1", { subject: "Write the thing", description: "all of it" }, undefined, undefined, undefined as never);
    const id = (created.details as { task: { id: string } }).task.id;

    await update.execute("2", { taskId: id, status: "in_progress" }, undefined, undefined, undefined as never);
    const listed = await list.execute("3", {}, undefined, undefined, undefined as never);
    match(listed.content[0].type === "text" ? listed.content[0].text : "", /\[in_progress\] Write the thing/);

    const fetched = await get.execute("4", { taskId: id }, undefined, undefined, undefined as never);
    match(fetched.content[0].type === "text" ? fetched.content[0].text : "", /"description": "all of it"/);

    const missing = await get.execute("5", { taskId: "999" }, undefined, undefined, undefined as never);
    strictEqual(missing.isError, true);
  });
});

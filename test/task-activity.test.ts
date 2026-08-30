import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api } from "grammy";
import { readToolActivity, TaskActivityBoard, type TaskActivityEvent } from "../src/agent/task-activity.ts";
import { TelegramTaskProgress } from "../src/channels/telegram/task-progress.ts";

const wrap = (activity: unknown) => ({ content: [{ type: "text", text: "working" }], details: { activity } });

describe("readToolActivity", () => {
  test("reads plan and agent rows a tool reported", () => {
    const events = readToolActivity(
      wrap([
        { kind: "plan", tasks: [{ id: "p1", title: "scout", status: "completed" }] },
        { kind: "agent", task: { id: "a1", title: "reader 1", status: "running", usage: { totalTokens: 900 } } },
      ]),
      "call-7",
    );
    deepStrictEqual(events, [
      { kind: "plan", scope: "call-7", tasks: [{ id: "call-7:p1", title: "scout", status: "completed" }] },
      { kind: "agent", task: { id: "call-7:a1", title: "reader 1", status: "running", usage: { totalTokens: 900 } } },
    ]);
  });

  test("namespaces ids, blockedBy included, and is idempotent on qualified ids", () => {
    // A tool reports the id it was handed back; qualifying twice would orphan
    // the row from the one already on screen.
    const [event] = readToolActivity(
      wrap([{ kind: "plan", tasks: [{ id: "call-7:p2", title: "fan out", status: "pending", blockedBy: ["p1"] }] }]),
      "call-7",
    );
    ok(event.kind === "plan");
    deepStrictEqual(event.tasks, [
      { id: "call-7:p2", title: "fan out", status: "pending", blockedBy: ["call-7:p1"] },
    ]);
  });

  test("drops malformed rows instead of throwing", () => {
    // The payload crosses a tool boundary (and MCP's transport): nothing about
    // its shape is guaranteed, and a bad report must never fail the tool call.
    const [event] = readToolActivity(
      wrap([{ kind: "plan", tasks: [{ id: "ok", title: "kept" }, { id: "no-title" }, null, "junk", { title: "no id" }] }]),
      "s",
    );
    ok(event.kind === "plan");
    deepStrictEqual(event.tasks.map((task) => task.id), ["s:ok"]);
    strictEqual(event.tasks[0].status, "running"); // missing status is not "pending"
  });

  test("ignores anything that is not an activity payload", () => {
    for (const value of [undefined, null, "text", 7, {}, { details: {} }, { details: { activity: "nope" } }]) {
      deepStrictEqual(readToolActivity(value, "s"), []);
    }
    // A tool that reports an unknown event kind reports nothing, not garbage.
    deepStrictEqual(readToolActivity(wrap([{ kind: "sprint", tasks: [] }]), "s"), []);
  });

  test("keeps an empty plan snapshot, which is how a tool clears its rows", () => {
    deepStrictEqual(readToolActivity(wrap([{ kind: "plan", tasks: [] }]), "s"), [
      { kind: "plan", scope: "s", tasks: [] },
    ]);
  });
});

/** Captures whatever the progress message renders. */
function fakeApi() {
  const sent: string[] = [];
  const api = {
    raw: {
      sendMessage: async (payload: { text: string }) => {
        sent.push(payload.text);
        return { message_id: sent.length };
      },
      editMessageText: async (payload: { text: string }) => {
        sent.push(payload.text);
        return true;
      },
    },
  } as unknown as Api;
  return { api, sent };
}

describe("TelegramTaskProgress plan scoping", () => {
  test("a tool's plan snapshot does not wipe the session's own plan", async () => {
    // Regression: plan snapshots used to clear the whole map, so the first tool
    // to report its phases erased the model's plan from the status message.
    const { api, sent } = fakeApi();
    const progress = new TelegramTaskProgress(api, 1);
    const session: TaskActivityEvent = { kind: "plan", tasks: [{ id: "1", title: "session task", status: "running" }] };
    const tool: TaskActivityEvent = { kind: "plan", scope: "call-7", tasks: [{ id: "call-7:p1", title: "tool phase", status: "pending" }] };

    progress.update(session);
    progress.update(tool);
    await progress.finish("completed");

    const text = sent.at(-1) ?? "";
    match(text, /session task/);
    match(text, /tool phase/);
  });

  test("a scope's snapshot replaces only its own rows", async () => {
    const { api, sent } = fakeApi();
    const progress = new TelegramTaskProgress(api, 1);
    progress.update({ kind: "plan", tasks: [{ id: "1", title: "session task", status: "running" }] });
    progress.update({ kind: "plan", scope: "call-7", tasks: [{ id: "call-7:p1", title: "first phase", status: "running" }] });
    progress.update({ kind: "plan", scope: "call-7", tasks: [{ id: "call-7:p2", title: "second phase", status: "running" }] });
    await progress.finish("completed");

    const text = sent.at(-1) ?? "";
    match(text, /session task/);
    match(text, /second phase/);
    strictEqual(/first phase/.test(text), false);
  });
});

describe("TaskActivityBoard", () => {
  test("agent events merge into the row they name", () => {
    // The roster reports incrementally — a progress event carries the last tool
    // but not the type it started with, and losing that would blank the row.
    const board = new TaskActivityBoard();
    board.apply({ kind: "agent", task: { id: "a1", title: "reader", status: "running", subagentType: "general-purpose" } });
    board.apply({ kind: "agent", task: { id: "a1", title: "reader", status: "running", lastToolName: "Grep" } });
    deepStrictEqual(board.agents, [
      { id: "a1", title: "reader", status: "running", subagentType: "general-purpose", lastToolName: "Grep" },
    ]);
  });

  test("a plan snapshot replaces only its own scope", () => {
    const board = new TaskActivityBoard();
    board.apply({ kind: "plan", tasks: [{ id: "1", title: "session", status: "running" }] });
    board.apply({ kind: "plan", scope: "call-7", tasks: [{ id: "call-7:p1", title: "phase one", status: "running" }] });
    board.apply({ kind: "plan", scope: "call-7", tasks: [{ id: "call-7:p2", title: "phase two", status: "running" }] });
    deepStrictEqual(board.plan.map((task) => task.title), ["session", "phase two"]);
  });

  test("a turn that stops terminates the rows still marked running", () => {
    // Nobody is left to report them, and a spinner that never resolves is worse
    // than a row that says it was cut off.
    const board = new TaskActivityBoard();
    board.apply({ kind: "agent", task: { id: "a1", title: "one", status: "running" } });
    board.apply({ kind: "agent", task: { id: "a2", title: "two", status: "completed" } });
    board.settle("stopped");
    deepStrictEqual(board.agents.map((task) => task.status), ["stopped", "completed"]);
  });

  test("an untouched board is empty", () => {
    const board = new TaskActivityBoard();
    strictEqual(board.empty, true);
    board.apply({ kind: "plan", tasks: [] });
    // An explicit empty plan is still a report, but there is nothing to draw.
    strictEqual(board.empty, true);
    board.apply({ kind: "plan", tasks: [{ id: "1", title: "t", status: "pending" }] });
    strictEqual(board.empty, false);
  });
});

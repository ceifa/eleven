import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Gateway as GatewayType } from "../src/gateway.ts";
import type { RunnerHooks, TurnEvents } from "../src/agent/runner.ts";

// The gateway's ledgers live in the state directory, which paths.ts resolves at
// import time — so it has to point at a temp dir before the module is loaded.
// (Type-only imports above are erased, so they don't load anything.)
const stateDir = mkdtempSync(join(tmpdir(), "eleven-gateway-"));
process.env.ELEVEN_STATE_DIR = stateDir;
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { Gateway } = await import("../src/gateway.ts");

const config = {
  resolved: { workspaces: { agent: { path: stateDir } }, models: [], session: {} },
  turnModels: () => [{ model: "claude-code/opus" }],
  on: () => {},
};

/** The gateway's own runner is the seam: replace `submit` with a fake turn, so
 *  a test can look at the live record from inside a turn that is still running
 *  — which is exactly the moment a dashboard reads it. */
function stubTurn(gateway: GatewayType, turn: (threadId: string, hooks: RunnerHooks, events: TurnEvents) => void) {
  const runner = gateway.runner as unknown as {
    hooks: RunnerHooks;
    submit: (id: string, request: unknown, events: TurnEvents) => Promise<unknown>;
  };
  runner.submit = async (threadId, _request, events) => {
    turn(threadId, runner.hooks, events);
    return undefined;
  };
}

function send(gateway: GatewayType, text: string) {
  return gateway.handle({ sessionKey: "telegram:main:-1001:topic:7", text, runtime: { channel: "telegram" } });
}

test("the message that starts a turn is in the live record, where a mid-turn page reads it", async () => {
  // Regression: the live record was created empty when the turn started, i.e.
  // *after* the message that started it was pushed — so it was dropped. On a
  // thread's first turn (right after /new) that record is the only copy there
  // is: pi keeps a brand-new session in memory until the model's first reply,
  // so the dashboard has no transcript file to read either, and the message
  // showed up nowhere until the turn ended.
  const gateway = new Gateway(config as never);
  let live: ReturnType<GatewayType["liveTurn"]>;
  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onDelta?.("on it");
    live = structuredClone(gateway.liveTurn(threadId));
  });

  await send(gateway, "check the logs");

  assert.deepEqual(
    live?.items.map((item) => (item.kind === "message" ? { kind: item.kind, role: item.role, text: item.text } : item)),
    [{ kind: "message", role: "user", text: "check the logs" }, { kind: "text", text: "on it" }],
  );
  // The transcript skips a message the live region already draws, but only for
  // rows dated at or after the turn's start — so the record cannot claim to
  // have begun after the message it opens with, or the bubble renders twice.
  const opener = live!.items[0];
  assert.ok(opener.kind === "message" && opener.at >= live!.startedAt);
});

test("a turn does not inherit the previous turn's live record", async () => {
  const gateway = new Gateway(config as never);
  const seen: string[][] = [];
  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onDelta?.("done");
    seen.push(gateway.liveTurn(threadId)!.items.map((item) => (item.kind === "message" ? item.text : item.kind)));
    // What the runner does once the turn (and its delivery) has settled.
    hooks.onTurnEnd?.(threadId);
  });

  await send(gateway, "first");
  await send(gateway, "second");

  assert.deepEqual(seen, [["first", "text"], ["second", "text"]]);
});

test("the board a mid-turn page reads is folded, and broadcast whole", async () => {
  // The dashboard must never have to replay events to know what the plan looks
  // like: the catch-up endpoint and the live broadcast carry the same folded
  // shape, so a page that connects late and one that watched all along agree.
  const gateway = new Gateway(config as never);
  const broadcasts: Array<{ plan: unknown[]; agents: unknown[]; agentTotal: number }> = [];
  gateway.on("task-activity", (event: { tasks: { plan: unknown[]; agents: unknown[]; agentTotal: number } }) => broadcasts.push(event.tasks));
  let live: ReturnType<GatewayType["liveTurn"]>;

  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onTaskActivity?.({ kind: "plan", tasks: [{ id: "1", title: "scout", status: "running" }] });
    events.onTaskActivity?.({ kind: "agent", task: { id: "a1", title: "reader", status: "running", subagentType: "general-purpose" } });
    // A tool reporting its own phases must not evict the session's plan.
    events.onTaskActivity?.({ kind: "plan", scope: "call-7", label: "workflow", tasks: [{ id: "call-7:p1", title: "fan out", status: "running" }] });
    // An incremental agent update merges rather than replacing the row.
    events.onTaskActivity?.({ kind: "agent", task: { id: "a1", title: "reader", status: "completed", usage: { totalTokens: 900 } } });
    live = gateway.liveTurn(threadId);
  });

  await send(gateway, "go");

  // Grouped by producer: the session's plan first, then the tool's own phases
  // under the tool's name — not one merged list.
  assert.deepEqual(live?.tasks.plan, [
    { tasks: [{ id: "1", title: "scout", status: "running" }] },
    { label: "workflow", tasks: [{ id: "call-7:p1", title: "fan out", status: "running" }] },
  ]);
  assert.deepEqual(live?.tasks.agents, [
    { id: "a1", title: "reader", status: "completed", subagentType: "general-purpose", usage: { totalTokens: 900 } },
  ]);
  // One broadcast per change, each carrying the whole board — the last one is
  // exactly what the catch-up endpoint would serve.
  assert.equal(broadcasts.length, 4);
  assert.deepEqual(broadcasts.at(-1), { plan: live?.tasks.plan, agents: live?.tasks.agents, agentTotal: 1 });
});

test("a turn that ends takes its board with it", async () => {
  // The board belongs to the running turn; the next one starts from nothing.
  const gateway = new Gateway(config as never);
  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onTaskActivity?.({ kind: "plan", tasks: [{ id: "1", title: "scout", status: "running" }] });
    hooks.onTurnEnd?.(threadId);
  });
  await send(gateway, "go");
  const thread = gateway.threads.current("telegram:main:-1001:topic:7");
  assert.equal(gateway.liveTurn(thread!.id), undefined);
});

test("a plan with work left is seeded into the next turn, marked as inherited", async () => {
  // Regression: the plan became durable, but each turn's status started empty —
  // so a thread with three open tasks showed none of them unless the model
  // happened to call TaskList again.
  const { taskStore } = await import("../src/agent/task-store.ts");
  const gateway = new Gateway(config as never);
  const sessionDir = join(stateDir, "threads", "agent");

  stubTurn(gateway, (threadId, hooks) => hooks.onTurnStart?.(threadId, undefined));
  await send(gateway, "first");
  const threadId = gateway.threads.current("telegram:main:-1001:topic:7")!.id;
  const store = taskStore(sessionDir, threadId);
  const open = store.create({ subject: "still open", description: "" });

  // The seed is emitted before the turn runs, so a turn that does nothing at
  // all is enough to observe it.
  const seen: Array<{ kind: string; seeded?: boolean; tasks?: { title: string }[] }> = [];
  await gateway.handle({
    sessionKey: "telegram:main:-1001:topic:7",
    text: "second",
    runtime: { channel: "telegram" },
    events: { onTaskActivity: (activity) => seen.push(activity as never) },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "plan");
  assert.equal(seen[0].seeded, true);
  assert.deepEqual(seen[0].tasks?.map((task) => task.title), ["still open"]);

  // Finished work is history: it must not follow the conversation forever.
  store.update(open.id, { status: "completed" });
  const after: unknown[] = [];
  await gateway.handle({
    sessionKey: "telegram:main:-1001:topic:7",
    text: "third",
    runtime: { channel: "telegram" },
    events: { onTaskActivity: (activity) => after.push(activity) },
  });
  assert.deepEqual(after, []);
});

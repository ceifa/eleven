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

test("turn-start carries the message that opened the turn", async () => {
  // Regression: a page watching the thread started its live region over from
  // nothing on turn-start. The launcher reads a new thread before that event
  // when the session is slow to load, so the first message (on screen from that
  // read, and in no transcript yet) vanished until the turn ended.
  const gateway = new Gateway(config as never);
  const starts: { startedAt: number; items: { kind: string; text?: string }[] }[] = [];
  gateway.on("turn-start", (event) => starts.push(event));
  stubTurn(gateway, (threadId, hooks) => hooks.onTurnStart?.(threadId, undefined));

  await send(gateway, "check the logs");

  assert.deepEqual(starts[0].items.map((item) => [item.kind, item.text]), [["message", "check the logs"]]);
  const thread = gateway.threads.current("telegram:main:-1001:topic:7");
  assert.equal(starts[0].startedAt, gateway.liveTurn(thread!.id)!.startedAt);
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

test("a mid-turn page reads every producer's panels, broadcast whole", async () => {
  // The dashboard must never have to replay updates to know what is on screen:
  // the catch-up endpoint and the live broadcast carry the same shape, so a
  // page that connects late and one that watched all along agree.
  const gateway = new Gateway(config as never);
  const broadcasts: unknown[] = [];
  gateway.on("panels", (event: { panels: unknown }) => broadcasts.push(event.panels));
  let live: ReturnType<GatewayType["liveTurn"]>;
  const plan = (text: string) => ({ title: "Plan", rows: [{ text, state: "active" as const }] });

  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onPanels?.({ scope: "tasks", panels: [plan("scout")] });
    // A tool publishing its own panels must not evict the plan.
    events.onPanels?.({ scope: "call-7", tool: "workflow", panels: [plan("fan out")] });
    events.onPanels?.({ scope: "tasks", panels: [plan("dig")] });
    live = gateway.liveTurn(threadId);
  });

  await send(gateway, "go");

  // In the order producers first reported, each replaced only by itself.
  assert.deepEqual(live?.panels, [plan("dig"), plan("fan out")]);
  // One broadcast per update, each carrying everything — the last one is
  // exactly what the catch-up endpoint would serve.
  assert.equal(broadcasts.length, 3);
  assert.deepEqual(broadcasts.at(-1), live?.panels);
});

test("a turn that ends takes its panels with it", async () => {
  // Panels belong to the running turn; the next one starts from nothing.
  const gateway = new Gateway(config as never);
  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onPanels?.({ scope: "tasks", panels: [{ title: "Plan", rows: [{ text: "scout", state: "active" }] }] });
    hooks.onTurnEnd?.(threadId);
  });
  await send(gateway, "go");
  const thread = gateway.threads.current("telegram:main:-1001:topic:7");
  assert.equal(gateway.liveTurn(thread!.id), undefined);
});

test("only an open Telegram or Discord conversation may be compacted while idle", async () => {
  const gateway = new Gateway(config as never);
  let allowed: (() => boolean) | undefined;
  const runner = gateway.runner as unknown as { submit: (id: string, request: { compactWhenIdle?: () => boolean }) => Promise<unknown> };
  runner.submit = async (_id, request) => {
    allowed = request.compactWhenIdle;
    return undefined;
  };
  const ask = async (sessionKey: string) => {
    allowed = undefined;
    await gateway.handle({ sessionKey, text: "hi", runtime: { channel: sessionKey.split(":", 1)[0] } });
    return allowed?.() ?? false;
  };

  assert.equal(await ask("telegram:main:-1001:topic:9"), true);
  assert.equal(await ask("discord:discord:1:2"), true);
  assert.equal(await ask("dashboard:agent:5b1f7a52-6a43-4f0e-9d0e-1d2f4a7c9e10"), false);
  assert.equal(await ask("cli:agent:5b1f7a52-6a43-4f0e-9d0e-1d2f4a7c9e11"), false);

  // Asked again when the timer fires: a conversation replaced or archived since is left alone.
  await ask("telegram:main:-1001:topic:10");
  const replaced = allowed!;
  gateway.newThread("telegram:main:-1001:topic:10");
  assert.equal(replaced(), false);
  await ask("discord:discord:1:3");
  const archived = allowed!;
  const thread = gateway.threads.current("discord:discord:1:3")!;
  gateway.threads.update(thread.id, { archiveRequested: true });
  assert.equal(archived(), false);
});

test("a failed durable handoff clears live activity but keeps interrupted generation recoverable", async () => {
  const gateway = new Gateway(config as never);
  let id = "";
  stubTurn(gateway, (threadId, hooks) => {
    id = threadId;
    hooks.onTurnStart?.(threadId, undefined);
    hooks.onTurnEnd?.(threadId, true);
  });
  await send(gateway, "save the finished answer");
  assert.equal(gateway.liveTurn(id), undefined);
  assert.ok(gateway.pending.drain().some((turn) => turn.threadId === id));
});

test("a final handoff cannot clear recovery for a newer conversation thread", () => {
  const gateway = new Gateway(config as never);
  const key = "telegram:main:123";
  const old = gateway.newThread(key, "agent");
  gateway.pending.begin(old.id, 100);
  const newer = gateway.newThread(key, "agent");
  gateway.pending.begin(newer.id, 200);
  gateway.queueReply(old.id, key, "old answer");
  assert.deepEqual(gateway.pending.drain(), [{ threadId: newer.id, lastAliveAt: 200 }]);
  assert.equal(gateway.pending.replies()[0].text, "old answer");
});

test("a chat turn can wake its conversation later, until the conversation moves on", async () => {
  const gateway = new Gateway(config as never);
  const woken: [string, string][] = [];
  gateway.waker = async (sessionKey, text) => { woken.push([sessionKey, text]); };
  const runner = gateway.runner as unknown as { submit: (id: string, request: { wake?: (text: string) => Promise<void> }) => Promise<unknown> };
  let wake: ((text: string) => Promise<void>) | undefined;
  runner.submit = async (_threadId, request) => { wake = request.wake; return undefined; };

  await send(gateway, "run the audit in the background");
  await wake!("audit finished");
  assert.deepEqual(woken, [["telegram:main:-1001:topic:7", "audit finished"]]);

  // /new: the background work belongs to a thread that is no longer open.
  gateway.newThread("telegram:main:-1001:topic:7");
  await assert.rejects(wake!("too late"), /no longer the open conversation/);
  assert.equal(woken.length, 1);

  await gateway.handle({ sessionKey: "dashboard:agent:x", text: "hi", runtime: { channel: "dashboard" } as never });
  assert.equal(wake, undefined, "a dashboard thread has no chat to wake");
});

test("/new ends all background handles from the old session without touching another chat", async () => {
  const { runInTurn } = await import("../src/agent/host-api.ts");
  const gateway = new Gateway(config as never);
  const key = "telegram:main:-1001:topic:7";
  const woken: string[] = [];
  gateway.waker = async (_key, text) => { woken.push(text); };
  const handles: NonNullable<ReturnType<NonNullable<typeof globalThis.eleven>["conversation"]>>[] = [];
  gateway.runner.submit = async (_id, request) => {
    handles.push(runInTurn({ panels: () => {}, wake: request.wake, sessionSignal: request.sessionSignal },
      () => globalThis.eleven!.conversation()!));
    return undefined;
  };
  await send(gateway, "first background run");
  await send(gateway, "second background run");
  await gateway.handle({ sessionKey: "telegram:main:another", text: "independent run", runtime: { channel: "telegram" } });
  assert.ok(handles.every((handle) => !handle.signal.aborted), "finishing a turn does not stop background work");

  gateway.newThread(key);
  assert.deepEqual(handles.map((handle) => handle.signal.aborted), [true, true, false]);
  assert.equal(await handles[0].wake("old result"), false);
  assert.equal(await handles[1].wake("old result"), false);
  assert.deepEqual(woken, []);

  await send(gateway, "new session's run");
  assert.equal(handles[3].signal.aborted, false);
  await handles[2].wake("other chat finished");
  await handles[3].wake("new session finished");
  assert.deepEqual(woken, ["other chat finished", "new session finished"]);
});

test("a wake that was already in delivery when /new arrived cannot enter the new session", async () => {
  const gateway = new Gateway(config as never);
  const key = "telegram:main:-1001:topic:7";
  let release!: () => void;
  const delivery = new Promise<void>((resolve) => { release = resolve; });
  let wake!: (text: string) => Promise<void>;
  let submits = 0;
  gateway.runner.submit = async (_id, request) => {
    submits++;
    wake = request.wake!;
    return undefined;
  };
  gateway.waker = async (sessionKey, text, expectedThreadId) => {
    await delivery;
    await gateway.handle({ sessionKey, text, expectedThreadId, runtime: { channel: "telegram" } });
  };
  await send(gateway, "start background work");
  const result = wake("old result");
  gateway.newThread(key);
  release();
  await assert.rejects(result, /no longer the open conversation/);
  assert.equal(submits, 1);
});

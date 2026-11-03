import assert from "node:assert/strict";
import test from "node:test";
import { runInTurn } from "../src/agent/host-api.ts";
import type { PanelUpdate } from "../src/agent/panels.ts";
import { BackgroundStatuses } from "../src/channels/background.ts";
import { TurnStatus, plainStatus } from "../src/channels/turn-status.ts";
import { DiscordTurnStatus, renderDiscordCard, STOP_BUTTON_ID } from "../src/channels/discord/status.ts";
import { TelegramTurnStatus } from "../src/channels/telegram/turn-status.ts";

const panels = [{ title: "Agents", rows: [{ text: "Audit", state: "active" as const }] }];

test("a background handle validates progress, survives the turn, and finishes once", async () => {
  const seen: PanelUpdate[] = [];
  const outcomes: string[] = [];
  let released = 0;
  let stop!: () => void;
  const handle = runInTurn({
    panels: () => assert.fail("background progress reached the turn"),
    wake: async () => {},
    hold: () => () => { released++; },
    createBackground: (options) => {
      assert.equal(options.title, "Workflow abc");
      stop = options.stop;
      return { panels: (update) => seen.push(update), finish: async (outcome) => { outcomes.push(outcome); } };
    },
  }, () => globalThis.eleven!.conversation({ title: "Workflow abc" })!);
  assert.equal(handle.progress("invalid"), false);
  assert.equal(handle.progress(panels), true);
  assert.deepEqual(seen, [{ scope: "background", panels }]);
  stop();
  assert.equal(handle.signal.aborted, true);
  assert.equal(released, 0, "the runtime is held until workers wind down");
  assert.equal(handle.progress(panels), false);
  await handle.finish("stopped");
  await handle.finish("completed");
  await handle.wake("stopped");
  assert.deepEqual(outcomes, ["stopped"]);
  assert.equal(released, 1);
});

test("a session reset aborts every handle, but a run's Stop affects only that run", async () => {
  const session = new AbortController();
  const stops: (() => void)[] = [];
  let wakes = 0;
  const context = {
    panels: () => {}, sessionSignal: session.signal, wake: async () => { wakes++; },
    createBackground: ({ stop }: { stop: () => void }) => {
      stops.push(stop);
      return { panels: () => {}, finish: async () => {} };
    },
  };
  const [a, b] = runInTurn(context, () => [globalThis.eleven!.conversation()!, globalThis.eleven!.conversation()!]);
  a.progress(panels);
  b.progress(panels);
  stops[0]();
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  session.abort();
  assert.equal(b.signal.aborted, true);
  assert.equal(await a.wake("old result"), false);
  assert.equal(await b.wake("old result"), false);
  assert.equal(wakes, 0);
  const late = runInTurn(context, () => globalThis.eleven!.conversation()!);
  assert.equal(late.signal.aborted, true);
  await late.finish("stopped");
});

test("a reset between finish and wake cannot deliver into the next session", async () => {
  const session = new AbortController();
  const handle = runInTurn({ panels: () => {}, sessionSignal: session.signal, wake: async () => assert.fail("stale wake") },
    () => globalThis.eleven!.conversation()!);
  await handle.finish("completed");
  session.abort();
  assert.equal(await handle.wake("done"), false);
});

test("a broken background surface cannot break the workflow", async () => {
  const handle = runInTurn({
    panels: () => {}, wake: async () => {},
    createBackground: () => ({ panels: () => { throw Error("offline"); }, finish: async () => { throw Error("offline"); } }),
  }, () => globalThis.eleven!.conversation()!);
  assert.equal(handle.progress(panels), false);
  await handle.finish("failed");
});

test("run buttons are scoped to their chat and removed at completion", async () => {
  const statuses = new BackgroundStatuses();
  let button = "";
  let stopped = 0;
  const status = statuses.create("chat-a", { title: "Audit", stop: () => { stopped++; } }, (id) => {
    button = id;
    return { panels: () => {}, finish: async () => {} };
  });
  assert.ok(Buffer.byteLength(button) <= 64);
  assert.equal(statuses.stop("chat-b", button), false);
  assert.equal(statuses.stop("chat-a", button), true);
  assert.equal(stopped, 1);
  await status.finish("stopped");
  assert.equal(statuses.stop("chat-a", button), false);
});

test("Discord background cards name the run and stop it, not the conversation's turn", async () => {
  const running = renderDiscordCard({ panels, running: { elapsedMs: 65_000 }, elapsedMs: 65_000 }, { title: "Workflow abc", stopId: "run-stop" });
  assert.match(JSON.stringify(running), /Workflow abc/);
  assert.match(JSON.stringify(running), /1m05s/);
  assert.match(JSON.stringify(running), /run-stop/);
  assert.ok(!JSON.stringify(running).includes(`"custom_id":"${STOP_BUTTON_ID}"`));
  const done = renderDiscordCard({ panels, outcome: "stopped", elapsedMs: 65_000 }, { title: "Workflow abc", stopId: "run-stop" });
  assert.ok(!JSON.stringify(done).includes("custom_id"));
  assert.match(JSON.stringify(done), /stopped/);

  const requests: string[] = [];
  const status = new DiscordTurnStatus({ request: async (method: string, url: string) => {
    requests.push(`${method} ${url}`);
    return { id: "message" };
  } } as never, "channel", undefined, { title: "Workflow abc", stopId: "run-stop" });
  status.start();
  await status.finish("stopped");
  assert.deepEqual(requests, ["POST /channels/channel/messages"], "background work must not leave the bot typing");
});

test("Telegram background progress edits one message and clears its stop keyboard", async () => {
  const calls: { method: string; payload: any }[] = [];
  const api = { raw: {
    sendMessage: async (payload: unknown) => { calls.push({ method: "post", payload }); return { message_id: 123 }; },
    editMessageText: async (payload: unknown) => { calls.push({ method: "edit", payload }); },
  } };
  const status = new TelegramTurnStatus(api as never, 901, { throttleMs: 1, topic: 7, background: { title: "Workflow abc", stopId: "run-stop" } });
  status.panels({ scope: "bg", panels });
  await new Promise((resolve) => setTimeout(resolve, 350));
  await status.finish("stopped");
  assert.deepEqual(calls.map((call) => call.method), ["post", "edit"]);
  assert.equal(calls[0].payload.message_thread_id, 7);
  assert.equal(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data, "run-stop");
  assert.equal(calls[1].payload.message_id, 123);
  assert.deepEqual(calls[1].payload.reply_markup.inline_keyboard, []);
  assert.match(calls[1].payload.text, /Workflow abc · stopped/);
  assert.match(calls[1].payload.text, /⏹ Audit/);
});

test("concurrent cards share a serialized chat edit budget", async () => {
  const times: number[] = [];
  const make = () => {
    const status = new TurnStatus({
      post: async () => { times.push(Date.now()); await new Promise((resolve) => setTimeout(resolve, 20)); },
      edit: async () => {}, remove: async () => {},
    }, { render: plainStatus, throttleMs: 25, rateKey: "concurrent-background-test" });
    status.panels({ scope: "bg", panels });
    return status;
  };
  await Promise.all([make().finish("completed"), make().finish("completed")]);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 40, `posts only ${times[1] - times[0]}ms apart`);
});

test("a background card first posted at completion does not leave an elapsed ticker alive", async () => {
  const status = new TurnStatus({ post: async () => {}, edit: async () => {}, remove: async () => {} },
    { render: plainStatus, throttleMs: 1, keepOnFinish: true });
  status.panels({ scope: "bg", panels });
  await status.finish("completed");
  assert.equal((status as unknown as { ticker?: NodeJS.Timeout }).ticker, undefined);
});

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingStatus() {
  const cards: string[] = [];
  const posts: string[] = [];
  const status = new TurnStatus({
    post: async (card) => { posts.push(card); cards.push(card); },
    edit: async (card) => { cards.push(card); },
    remove: async () => assert.fail("a card drawing a run was removed"),
  }, { render: plainStatus, throttleMs: 1 });
  return { status, cards, posts };
}

test("a run keeps drawing in the card of the turn that started it after the turn ends", async () => {
  const { status, cards, posts } = recordingStatus();
  status.start();
  const run = status.attach("Workflow abc", "run-stop");
  run.panels({ scope: "background", panels });
  await status.finish("completed");
  status.cancel();
  run.panels({ scope: "background", panels: [{ title: "Agents", rows: [{ text: "Audit", state: "done" }] }] });
  await sleep(300);
  await run.finish("completed");
  assert.equal(posts.length, 1, "the run must not open a message of its own");
  assert.match(cards.at(-1)!, /^✅ Turn completed/);
  assert.match(cards.at(-1)!, /✅ Workflow abc · completed/);
  assert.match(cards.at(-1)!, /✅ Audit/);
  assert.equal((status as unknown as { ticker?: NodeJS.Timeout }).ticker, undefined);
  const settled = cards.length;
  run.panels({ scope: "background", panels });
  await sleep(50);
  assert.equal(cards.length, settled, "a settled run draws nothing more");
});

test("a stopped or failed turn leaves its runs running", async () => {
  const { status, cards } = recordingStatus();
  const run = status.attach("Workflow abc", "run-stop");
  run.panels({ scope: "background", panels });
  await status.finish("stopped");
  status.cancel();
  assert.match(cards.at(-1)!, /⏹ Turn stopped/);
  assert.match(cards.at(-1)!, /⚙️ Workflow abc · running/);
  assert.match(cards.at(-1)!, /⏳ Audit/);
  await run.finish("failed");
  assert.match(cards.at(-1)!, /❌ Workflow abc · failed/);
  assert.match(cards.at(-1)!, /⏹ Audit/);
});

test("Discord turn cards carry a Stop per live run, apart from the turn's own", () => {
  const run = { title: "Workflow abc", stopId: "run-stop", panels, elapsedMs: 65_000 };
  const json = (view: Parameters<typeof renderDiscordCard>[0]) => JSON.stringify(renderDiscordCard(view));
  const during = json({ panels: [], running: { elapsedMs: 1_000 }, runs: [run] });
  assert.match(during, new RegExp(`"custom_id":"${STOP_BUTTON_ID}"`));
  assert.match(during, /"custom_id":"run-stop"/);
  const after = json({ panels: [], outcome: "completed", runs: [run] });
  assert.match(after, /Done/);
  assert.match(after, /Workflow abc\*\* · running/);
  assert.match(after, /1m05s/);
  assert.match(after, /"custom_id":"run-stop"/);
  assert.ok(!after.includes(`"custom_id":"${STOP_BUTTON_ID}"`), "a finished turn has nothing of its own to stop");
  assert.match(after, /"accent_color":5793266/, "a card with live runs still reads as running");
  const settled = json({ panels: [], outcome: "completed", runs: [{ ...run, outcome: "completed" }] });
  assert.ok(!settled.includes("custom_id"));
  assert.match(settled, /Workflow abc\*\* · completed/);
});

test("Discord background runs leave no typing indicator behind the finished turn", async () => {
  const requests: string[] = [];
  let typing = 0;
  const status = new DiscordTurnStatus({ request: async (method: string, url: string) => {
    if (url.endsWith("/typing")) typing++;
    else requests.push(`${method} ${url}`);
    return { id: "message" };
  } } as never, "channel");
  status.start();
  const run = status.attach("Workflow abc", "run-stop");
  await status.finish("completed");
  status.cancel();
  const typed = typing;
  await run.finish("completed");
  assert.equal(typing, typed);
  assert.deepEqual(new Set(requests), new Set(["POST /channels/channel/messages", "PATCH /channels/channel/messages/message"]));
});

test("Telegram draws a run in the turn's message and clears its stop keyboard", async () => {
  const calls: { method: string; payload: any }[] = [];
  const api = { raw: {
    sendMessage: async (payload: unknown) => { calls.push({ method: "post", payload }); return { message_id: 123 }; },
    editMessageText: async (payload: unknown) => { calls.push({ method: "edit", payload }); },
  } };
  const status = new TelegramTurnStatus(api as never, 901, { throttleMs: 1, topic: 7 });
  const run = status.attach("Workflow abc", "run-stop");
  run.panels({ scope: "background", panels });
  await sleep(350);
  await status.finish("completed");
  status.cancel();
  await run.finish("stopped");
  assert.deepEqual(calls.filter((call) => call.method === "post").length, 1);
  assert.equal(calls[0].payload.message_thread_id, 7);
  assert.equal(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data, "run-stop");
  const last = calls.at(-1)!;
  assert.equal(last.payload.message_id, 123);
  assert.deepEqual(last.payload.reply_markup.inline_keyboard, []);
  assert.match(last.payload.text, /Workflow abc · stopped/);
  assert.match(last.payload.text, /⏹ Audit/);
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

test("a card first posted at completion does not leave an elapsed ticker alive", async () => {
  const status = new TurnStatus({ post: async () => {}, edit: async () => {}, remove: async () => {} },
    { render: plainStatus, throttleMs: 1 });
  const run = status.attach("Workflow abc", "run-stop");
  run.panels({ scope: "bg", panels });
  await run.finish("completed");
  await status.finish("completed");
  assert.equal((status as unknown as { ticker?: NodeJS.Timeout }).ticker, undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { TurnFailure, turnFailure } from "../src/agent/runner.ts";
import { continuePrompt, FAILOVER_PREFIX, FailoverOffers } from "../src/channels/telegram/failover.ts";

const PLAN = [
  { model: "claude-code/opus" },
  { model: "openai-codex/gpt-5" },
  { model: "github-copilot/sonnet" },
];

const TAIL = [{ model: "openai-codex/gpt-5" }, { model: "github-copilot/sonnet" }];

test("a turn that stops mid-plan reports the candidates it never tried", () => {
  const error = turnFailure(new Error("provider error on claude-code/opus: usage limit reached"), PLAN, 0);

  assert.ok(error instanceof TurnFailure);
  assert.equal(error.message, "provider error on claude-code/opus: usage limit reached");
  assert.equal(error.failedModel, "claude-code/opus");
  assert.deepEqual(error.remaining, TAIL);
});

test("a turn that exhausted the plan fails plainly — there is nothing left to offer", () => {
  const cause = new Error("empty response from github-copilot/sonnet");
  const error = turnFailure(cause, PLAN, PLAN.length - 1);

  assert.equal(error, cause);
  assert.ok(!(error instanceof TurnFailure));
});

test("a turn that failed before any candidate ran keeps its own error", () => {
  const error = turnFailure(undefined, [], 0);

  assert.ok(!(error instanceof TurnFailure));
  assert.equal(error.message, "all models failed");
});

/** The keyboard a failure carries, and the callback data of one of its buttons. */
function offerFor(offers: FailoverOffers<string>, sessionKey = "telegram:main:7", rewind?: { from: string; to: string }) {
  const keyboard = offers.offer(sessionKey, "replay", { remaining: TAIL, rewind, hiddenToolCalls: [] });
  const buttons = keyboard?.inline_keyboard[0] ?? [];
  return {
    labels: buttons.map((button) => ("text" in button ? button.text : "")),
    data: (mode: "continue" | "restart") => {
      const button = buttons.find((b) => "callback_data" in b && b.callback_data.endsWith(`:${mode}`));
      return button && "callback_data" in button ? button.callback_data : "";
    },
  };
}

test("a failure with candidates left offers both ways out, on the next model", () => {
  const offers = new FailoverOffers<string>();
  const { labels, data } = offerFor(offers);

  assert.deepEqual(labels, ["▶ Continue on gpt-5", "↻ Restart on gpt-5"]);
  assert.ok(data("continue").startsWith(FAILOVER_PREFIX));
  assert.ok(Buffer.byteLength(data("restart")) <= 64);
});

test("a restart claims the rewind; a continue leaves the failed attempt in place", () => {
  const offers = new FailoverOffers<string>();
  const rewind = { from: "leaf-9", to: "leaf-4" };

  const restarted = offerFor(offers, "telegram:main:7", rewind);
  const restart = offers.take(restarted.data("restart"), "telegram:main:7");
  assert.equal(restart?.mode, "restart");
  // The retry runs the untried tail, next model leading.
  assert.deepEqual(restart?.models, TAIL);
  assert.deepEqual(restart?.rewind, rewind);

  const continued = offerFor(offers, "telegram:main:7", rewind);
  assert.equal(offers.take(continued.data("continue"), "telegram:main:7")?.mode, "continue");
});

test("the two buttons answer one failure — taking either retires both", () => {
  const offers = new FailoverOffers<string>();
  const { data } = offerFor(offers);

  assert.ok(offers.take(data("continue"), "telegram:main:7"));
  // A second press (or a redelivered update) cannot run the turn again.
  assert.equal(offers.take(data("continue"), "telegram:main:7"), undefined);
  assert.equal(offers.take(data("restart"), "telegram:main:7"), undefined);
});

test("an offer only fires in the conversation it was made in, and only while fresh", () => {
  const offers = new FailoverOffers<string>();

  const elsewhere = offerFor(offers).data("continue");
  assert.equal(offers.take(elsewhere, "telegram:main:9"), undefined);

  const stale = offerFor(offers).data("continue");
  assert.equal(offers.take(stale, "telegram:main:7", Date.now() + 31 * 60 * 1000), undefined);

  const superseded = offerFor(offers).data("continue");
  offers.clear("telegram:main:7");
  assert.equal(offers.take(superseded, "telegram:main:7"), undefined);
});

test("a failure with nothing left in the plan gets no buttons", () => {
  const offers = new FailoverOffers<string>();
  assert.equal(offers.offer("telegram:main:7", "replay", { remaining: [], hiddenToolCalls: [] }), undefined);
});

test("a continue names the tool calls the next model cannot read back", () => {
  const offers = new FailoverOffers<string>();
  const hiddenToolCalls = [
    { id: "claude:0", name: "Bash", args: { command: "npm test" } },
    { id: "claude:1", name: "telegram", args: { action: "send", text: "the report is ready" } },
  ];
  const keyboard = offers.offer("telegram:main:7", "replay", { remaining: TAIL, hiddenToolCalls });
  const button = keyboard!.inline_keyboard[0]![0]!;
  const taken = offers.take("callback_data" in button ? button.callback_data : "", "telegram:main:7");

  const prompt = continuePrompt(taken!.hiddenToolCalls);
  // A send is exactly the side effect no amount of reading the workspace recovers.
  assert.match(prompt, /- Bash npm test/);
  assert.match(prompt, /- telegram send/);
  assert.match(prompt, /don't repeat them/);
});

test("a continue after a runtime whose calls are already in context stays one line", () => {
  const prompt = continuePrompt([]);

  assert.ok(!prompt.includes("\n"));
  assert.ok(prompt.length < 160);
  assert.match(prompt, /don't repeat them/);
});

test("a long attempt lists only its recent calls, and says how many it dropped", () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({ id: `claude:${i}`, name: "Read", args: { path: `file-${i}.ts` } }));
  const prompt = continuePrompt(calls);

  assert.match(prompt, /\(25 earlier calls omitted\)/);
  assert.ok(!prompt.includes("file-24.ts"));
  assert.match(prompt, /file-25\.ts/);
  assert.match(prompt, /file-39\.ts/);
});

test("callback data that is not a live offer is refused, not guessed at", () => {
  const offers = new FailoverOffers<string>();
  const { data } = offerFor(offers);

  assert.equal(offers.take("some agent button", "telegram:main:7"), undefined);
  assert.equal(offers.take(`${FAILOVER_PREFIX}deadbeef:continue`, "telegram:main:7"), undefined);
  // An unknown mode must not silently fall through to one of the real ones.
  assert.equal(offers.take(data("continue").replace(":continue", ":wipe"), "telegram:main:7"), undefined);
});


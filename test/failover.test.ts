import assert from "node:assert/strict";
import test from "node:test";
import { TurnFailure, turnFailure } from "../src/agent/runner.ts";
import { FAILOVER_PREFIX, FailoverOffers, retryPrompt } from "../src/channels/telegram/failover.ts";

const PLAN = [
  { model: "claude-code/opus" },
  { model: "openai-codex/gpt-5" },
  { model: "github-copilot/sonnet" },
];

test("a turn that stops mid-plan reports the candidates it never tried", () => {
  const error = turnFailure(new Error("provider error on claude-code/opus: usage limit reached"), PLAN, 0);

  assert.ok(error instanceof TurnFailure);
  assert.equal(error.message, "provider error on claude-code/opus: usage limit reached");
  assert.equal(error.failedModel, "claude-code/opus");
  assert.deepEqual(error.remaining, [{ model: "openai-codex/gpt-5" }, { model: "github-copilot/sonnet" }]);
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

test("a failure with candidates left carries a button naming the next model", () => {
  const offers = new FailoverOffers<{ chatId: number }>();
  const keyboard = offers.offer("telegram:main:7", { chatId: 7 }, {
    message: "provider error on claude-code/opus: usage limit reached",
    failedModel: "claude-code/opus",
    remaining: [{ model: "openai-codex/gpt-5" }, { model: "github-copilot/sonnet" }],
  });

  const button = keyboard?.inline_keyboard[0]?.[0];
  assert.equal(button && "text" in button ? button.text : undefined, "↻ Retry on gpt-5");
  const data = button && "callback_data" in button ? button.callback_data : "";
  assert.ok(data.startsWith(FAILOVER_PREFIX));
  assert.ok(Buffer.byteLength(data) <= 64);

  const offer = offers.take(data, "telegram:main:7");
  // The retry runs the untried tail, next model leading.
  assert.deepEqual(offer?.models, [{ model: "openai-codex/gpt-5" }, { model: "github-copilot/sonnet" }]);
  // Consumed: a second press (or a redelivered update) cannot run it twice.
  assert.equal(offers.take(data, "telegram:main:7"), undefined);
});

test("an offer only fires in the conversation it was made in, and only while fresh", () => {
  const offers = new FailoverOffers<{ chatId: number }>();
  const failure = { message: "spent", failedModel: "claude-code/opus", remaining: [{ model: "openai-codex/gpt-5" }] };
  const data = (markup: ReturnType<FailoverOffers<{ chatId: number }>["offer"]>) => {
    const button = markup?.inline_keyboard[0]?.[0];
    return button && "callback_data" in button ? button.callback_data : "";
  };

  const elsewhere = data(offers.offer("telegram:main:7", { chatId: 7 }, failure));
  assert.equal(offers.take(elsewhere, "telegram:main:9"), undefined);

  const stale = data(offers.offer("telegram:main:7", { chatId: 7 }, failure));
  assert.equal(offers.take(stale, "telegram:main:7", Date.now() + 31 * 60 * 1000), undefined);

  const superseded = data(offers.offer("telegram:main:7", { chatId: 7 }, failure));
  offers.clear("telegram:main:7");
  assert.equal(offers.take(superseded, "telegram:main:7"), undefined);
});

test("a failure with nothing left in the plan gets no button", () => {
  const offers = new FailoverOffers<{ chatId: number }>();
  assert.equal(
    offers.offer("telegram:main:7", { chatId: 7 }, { message: "spent", failedModel: "claude-code/opus", remaining: [] }),
    undefined,
  );
});

test("the retry prompt names both models and warns off replaying side effects", () => {
  const prompt = retryPrompt({
    target: undefined,
    models: [{ model: "openai-codex/gpt-5" }],
    failedModel: "claude-code/opus",
    reason: "usage limit reached",
    sessionKey: "telegram:main:7",
    at: Date.now(),
  });

  assert.match(prompt, /stopped on opus: usage limit reached/);
  assert.match(prompt, /retry it on gpt-5/);
  assert.match(prompt, /do not repeat their side effects/);
});

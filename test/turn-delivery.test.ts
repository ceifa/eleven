import assert from "node:assert/strict";
import test from "node:test";
import { createTurnDelivery, runChatTurn, type ChatTurn } from "../src/channels/turn.ts";
import { FailoverOffers } from "../src/channels/failover.ts";
import { logger } from "../src/log.ts";

test("an early send is confirmed only after the chat accepts it", async () => {
  const sent = new Set<string>();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const delivery = createTurnDelivery(async () => held, sent, () => {});
  delivery.early("answer");
  assert.equal(sent.has("answer"), false);
  release();
  await delivery.settled();
  assert.equal(sent.has("answer"), true);
});

test("a failed early answer stays owed even after steering clears its blocks", async () => {
  const failures: unknown[] = [];
  const sent = new Set<string>();
  const delivery = createTurnDelivery(async () => { throw new Error("offline"); }, sent, (error) => failures.push(error));
  delivery.catchUp(["first answer"]);
  await delivery.settled();
  assert.equal(failures.length, 1);
  assert.equal(sent.has("first answer"), false);
  assert.equal(delivery.remaining(["second answer"], "second answer"), "first answer\n\nsecond answer");
});

test("the final send waits for early delivery before deciding what reached the chat", async () => {
  const posted: string[] = [];
  let sends = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const turn: ChatTurn<undefined> = {
    gateway: {
      handle: async (incoming) => {
        incoming.events!.onDelta!("early answer");
        incoming.events!.onAssistantText!();
        incoming.events!.onEarlyAnswer!("early answer");
        setTimeout(release, 10);
        await incoming.deliver!({ text: "early answer", status: "completed" } as never);
      },
    } as ChatTurn<undefined>["gateway"],
    sessionKey: "discord:test:1:2",
    text: "question",
    images: [],
    incoming: {},
    sent: new Set(),
    status: { start() {}, panels() {}, tool() {}, retry() {}, async finish() {}, cancel() {} },
    send: async (text) => {
      if (++sends === 1) {
        await held;
        throw new Error("connection lost");
      }
      posted.push(text);
    },
    failovers: new FailoverOffers(),
    replay: undefined,
    autoFailover: () => false,
    log: logger("delivery-test"),
  };

  await runChatTurn(turn);

  assert.deepEqual(posted, ["early answer"]);
  assert.equal(turn.sent.size, 0);
});

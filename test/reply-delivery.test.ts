import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PendingTurns } from "../src/threads/pending.ts";
import { DeliveryRevoked, ReplyDelivery } from "../src/channels/replies.ts";
import { runChatTurn, type ChatTurn } from "../src/channels/turn.ts";
import { FailoverOffers } from "../src/channels/failover.ts";
import { logger } from "../src/log.ts";
import { Channels } from "../src/channels/index.ts";

const ledger = () => new PendingTurns(join(mkdtempSync(join(tmpdir(), "eleven-replies-")), "pending.json"));
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, "condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a completed final survives restart without becoming an interrupted model turn", async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "eleven-replies-")), "pending.json");
  const pending = new PendingTurns(file);
  pending.begin("thread", 1);
  pending.complete("thread", "telegram:main:1", "the answer", "42");
  const reopened = new PendingTurns(file);
  assert.deepEqual(reopened.drain(), []);
  const posted: { key: string; text: string; replyTo?: string }[] = [];
  const worker = new ReplyDelivery(reopened, async (key, text, options) => { posted.push({ key, text, replyTo: options.replyTo }); });
  t.after(() => worker.stop());
  worker.kick();
  await until(() => !reopened.replies().length);
  assert.deepEqual(posted, [{ key: "telegram:main:1", text: "the answer", replyTo: "42" }]);
  assert.deepEqual(new PendingTurns(file).replies(), []);
});

test("a failed head blocks only its conversation and a restart retries the saved text", async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "eleven-replies-")), "pending.json");
  const pending = new PendingTurns(file);
  pending.complete("one", "telegram:main:1", "first");
  pending.complete("two", "telegram:main:1", "second");
  pending.complete("three", "discord:main:1:2", "independent");
  const posted: string[] = [];
  const worker = new ReplyDelivery(pending, async (_key, text) => {
    if (text === "first") throw new Error("offline");
    posted.push(text);
  });
  t.after(() => worker.stop());
  worker.kick();
  await until(() => posted.length === 1 && pending.replies()[0]?.attempts === 1);
  assert.deepEqual(posted, ["independent"]);
  worker.stop();
  const reopened = new PendingTurns(file);
  reopened.failed(reopened.replies()[0].id, "retry due", false, 0);
  const retry = new ReplyDelivery(reopened, async (_key, text) => { posted.push(text); });
  t.after(() => retry.stop());
  retry.kick();
  await until(() => !reopened.replies().length);
  assert.deepEqual(posted, ["independent", "first", "second"]);
});

test("an interrupted newer turn is retained beside an older pending final", () => {
  const pending = ledger();
  pending.begin("same");
  pending.complete("same", "telegram:main:1", "older final");
  pending.begin("same", 123);
  assert.deepEqual(pending.drain(), [{ threadId: "same", lastAliveAt: 123 }]);
  assert.equal(pending.replies()[0].text, "older final");
});

test("legacy running-turn ledgers still migrate and recover", () => {
  const file = join(mkdtempSync(join(tmpdir(), "eleven-replies-")), "pending.json");
  writeFileSync(file, JSON.stringify({ old: { threadId: "old", lastAliveAt: 123 } }));
  const pending = new PendingTurns(file);
  assert.deepEqual(pending.drain(), [{ threadId: "old", lastAliveAt: 123 }]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("a persistence failure leaves the running turn recoverable", () => {
  const root = mkdtempSync(join(tmpdir(), "eleven-replies-"));
  const file = join(root, "pending.json");
  const pending = new PendingTurns(file);
  pending.begin("thread", 123);
  renameSync(file, `${file}.backup`);
  mkdirSync(file);
  assert.throws(() => pending.complete("thread", "telegram:main:1", "answer"));
  assert.equal(pending.replies().length, 0);
  assert.deepEqual(new PendingTurns(`${file}.backup`).drain(), [{ threadId: "thread", lastAliveAt: 123 }]);
});

test("revoked destinations are blocked durably and never reach the transport", async (t) => {
  const pending = ledger();
  pending.complete("thread", "telegram:main:1", "private answer");
  let allowed = false;
  let sent = 0;
  const channels = new Channels({ channels: () => [{ channel: { type: "telegram", name: "main", users: allowed ? { "1": {} } : {} } }] } as never, {} as never, [{
    type: "telegram", sendToSession: async () => { sent++; return {}; },
  }] as never);
  const worker = new ReplyDelivery(pending, (key, text, options) => channels.sendReply(key, text, options));
  t.after(() => worker.stop());
  worker.kick();
  await until(() => !!pending.replies()[0]?.blocked);
  allowed = true;
  worker.kick();
  assert.equal(sent, 0);
  assert.ok(pending.replies()[0].error?.includes("no longer allowed"));
  assert.ok(DeliveryRevoked.prototype instanceof Error);
});

test("a final is committed before status cleanup and retried without a second model call", async (t) => {
  const pending = ledger();
  let generated = 0;
  let attempts = 0;
  const posted: string[] = [];
  const key = "discord:main:1:2";
  const worker = new ReplyDelivery(pending, async (_key, text) => {
    if (++attempts === 1) throw new Error("offline");
    posted.push(text);
  });
  t.after(() => worker.stop());
  const turn: ChatTurn<undefined> = {
    gateway: {
      hasPendingReply: () => pending.replies().length > 0,
      queueReply: (_id: string, sessionKey: string, text: string) => { pending.complete("thread", sessionKey, text); worker.kick(); },
      handle: async (incoming) => {
        generated++;
        pending.begin("thread");
        await incoming.deliver!({ text: "finished answer", status: "completed" } as never, "thread");
      },
    } as ChatTurn<undefined>["gateway"],
    sessionKey: key, text: "question", images: [], incoming: {}, sent: new Set(),
    status: { start() {}, panels() {}, tool() {}, retry() {}, finish: async () => { assert.ok(pending.replies().length, "final must be durable before status cleanup"); throw new Error("status offline"); }, cancel() {} },
    send: async () => { throw new Error("the final must use the outbox"); },
    failovers: new FailoverOffers(), replay: undefined, autoFailover: () => false, log: logger("delivery-test"),
  };
  await runChatTurn(turn);
  await until(() => pending.replies()[0]?.attempts === 1);
  assert.deepEqual(pending.drain(), []);
  pending.failed(pending.replies()[0].id, "retry due", false, 0);
  worker.kick();
  await until(() => posted.length === 1);
  assert.deepEqual(posted, ["finished answer"]);
  assert.equal(generated, 1);
});


test("quarantined replies do not revive or block a newly authorized answer", async (t) => {
  const pending = ledger();
  pending.complete("old", "telegram:main:1", "old private answer");
  pending.failed(pending.replies()[0].id, "revoked", true);
  assert.equal(pending.hasReply("telegram:main:1"), false);
  pending.complete("new", "telegram:main:1", "new authorized answer");
  const posted: string[] = [];
  const worker = new ReplyDelivery(pending, async (_key, text) => { posted.push(text); });
  t.after(() => worker.stop());
  worker.kick();
  await until(() => posted.length === 1);
  assert.deepEqual(posted, ["new authorized answer"]);
  assert.equal(pending.replies()[0].blocked, true);
});

test("a failed final persistence cleans live state without clearing interrupted generation", async () => {
  const { Runner } = await import("../src/agent/runner.ts");
  const ended: unknown[] = [];
  const runner = new Runner({ onTurnEnd: (...args) => ended.push(args) });
  const seam = runner as unknown as { runTurn: () => Promise<unknown> };
  seam.runTurn = async () => ({ text: "finished", status: "completed" });
  await assert.rejects(runner.submit("thread", { deliver: async () => { throw new Error("disk full"); } } as never), /disk full/);
  assert.deepEqual(ended, [["thread", true]]);
});

test("a turn that ends with no text queues nothing for the chat", async () => {
  const pending = ledger();
  const turn: ChatTurn<undefined> = {
    gateway: {
      hasPendingReply: () => pending.replies().length > 0,
      queueReply: (_id: string, sessionKey: string, text: string) => pending.complete("thread", sessionKey, text),
      handle: async (incoming) => {
        pending.begin("thread");
        await incoming.deliver!({ text: "", status: "completed" } as never, "thread");
      },
    } as ChatTurn<undefined>["gateway"],
    sessionKey: "discord:main:1:2", text: "question", images: [], incoming: {}, sent: new Set(["the answer, with buttons"]),
    status: { start() {}, panels() {}, tool() {}, retry() {}, finish: async () => {}, cancel() {} },
    send: async () => { throw new Error("nothing should be sent"); },
    failovers: new FailoverOffers(), replay: undefined, autoFailover: () => false, log: logger("delivery-test"),
  };
  await runChatTurn(turn);
  assert.deepEqual(pending.replies(), []);
  assert.deepEqual(pending.drain(), []);
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PendingTurns } from "../src/threads/pending.ts";
import { ReplyDelivery } from "../src/channels/replies.ts";
import { TelegramChannel } from "../src/channels/telegram/index.ts";
import { sendToTelegramSession } from "../src/channels/telegram/bot.ts";
import { DiscordChannel } from "../src/channels/discord/index.ts";
import { sendMessage } from "../src/channels/discord/send.ts";
import { DiscordApiError } from "../src/channels/discord/rest.ts";
import { GoogleChatChannel } from "../src/channels/googlechat/index.ts";
import { GoogleChatApi, GoogleChatApiError, canRetrySend as canRetryChatSend } from "../src/channels/googlechat/api.ts";

/** A platform's channel with one running bot, "main", whose `send` is the one
 *  given: what the reply worker delivers through. */
function channelWith(platform: "telegram" | "discord", send: (key: string, text: string, options?: never) => Promise<unknown>) {
  const config = { on() {}, channels: () => [] };
  const channel = platform === "telegram" ? new TelegramChannel(config as never, {} as never, {} as never) : new DiscordChannel(config as never, {} as never, {} as never);
  (channel as unknown as { pool: { bots: Map<string, unknown> } }).pool.bots.set("main", { token: "test", handle: { send } });
  return channel.sendToSession.bind(channel);
}

async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < end, "condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const platform of ["telegram", "discord"] as const) {
  test(`${platform}: a confirmed chunk is checkpointed and skipped after restart`, async (t) => {
    const file = join(mkdtempSync(join(tmpdir(), "eleven-chunks-")), "pending.json");
    const key = platform === "telegram" ? "telegram:main:1" : "discord:main:1:2";
    const pending = new PendingTurns(file);
    const size = platform === "telegram" ? 20_000 : 1500;
    pending.complete("thread", key, `${"A".repeat(size)}\n\n${"B".repeat(size)}`);
    let offline = true;
    const posted: string[] = [];
    const record = async (text: string) => {
      if (offline && text.startsWith("B")) {
        if (platform === "discord") throw new DiscordApiError(429, { message: "rate limited" });
        throw { code: "ECONNREFUSED" };
      }
      posted.push(text);
      return {};
    };
    const send = channelWith(platform, platform === "telegram"
      ? (key, text, options) => sendToTelegramSession({ raw: { sendRichMessage: (payload: { rich_message: { markdown: string } }) => record(payload.rich_message.markdown) } } as never, key, text, options)
      : (_key, text, options: Parameters<typeof sendMessage>[3]) =>
          sendMessage({ request: (_method: string, _path: string, request: { body: { content: string } }) => record(request.body.content) } as never, "2", text, options));
    const worker = new ReplyDelivery(pending, send);
    t.after(() => worker.stop());
    worker.kick();
    await until(() => pending.replies()[0]?.attempts === 1);
    assert.equal(pending.replies()[0].sentChunks, 1);
    assert.equal(pending.replies()[0].blocked, false);
    assert.equal(posted.length, 1);
    worker.stop();
    offline = false;
    const reopened = new PendingTurns(file);
    reopened.failed(reopened.replies()[0].id, "retry due", false, 0);
    const retry = new ReplyDelivery(reopened, send);
    t.after(() => retry.stop());
    retry.kick();
    await until(() => !reopened.replies().length);
    assert.equal(posted.length, 2);
    assert.ok(posted[0].startsWith("A"));
    assert.ok(posted[1].startsWith("B"));
  });

  test(`${platform}: ambiguous sends are quarantined rather than retried`, async (t) => {
    const pending = new PendingTurns(join(mkdtempSync(join(tmpdir(), "eleven-uncertain-")), "pending.json"));
    const key = platform === "telegram" ? "telegram:main:1" : "discord:main:1:2";
    pending.complete("thread", key, "answer");
    let calls = 0;
    const fail = async () => { calls++; throw new Error("response lost after connection"); };
    const send = channelWith(platform, platform === "telegram"
      ? (key, text, options) => sendToTelegramSession({ raw: { sendRichMessage: fail } } as never, key, text, options)
      : fail);
    const worker = new ReplyDelivery(pending, send);
    t.after(() => worker.stop());
    worker.kick();
    await until(() => !!pending.replies()[0]?.blocked);
    worker.kick();
    assert.equal(calls, 1);
    assert.ok(pending.replies()[0].error?.includes("needs inspection"));
  });
}

test("Discord retains uncertainty when a lost response is followed by safe failures", async () => {
  const { DiscordRest, DiscordSendUncertain, canRetrySend } = await import("../src/channels/discord/rest.ts");
  let calls = 0;
  const rest = new DiscordRest("fake", async () => {
    calls++;
    if (calls === 1) throw new Error("response lost");
    throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  });
  await assert.rejects(rest.request("POST", "/channels/2/messages", { creates: true, body: { content: "answer" } }), (error) => {
    assert.ok(error instanceof DiscordSendUncertain);
    assert.equal(canRetrySend(error), false);
    return true;
  });
  assert.equal(calls, 4);
});

// Google Chat used to retry every failed final answer, whatever the failure:
// one whose response was lost after the message had posted went out again.
test("Google Chat quarantines an answer that may have landed, and retries one that cannot have", async (t) => {
  const deliver = async (failure: unknown) => {
    const pending = new PendingTurns(join(mkdtempSync(join(tmpdir(), "eleven-gchat-")), "pending.json"));
    pending.complete("thread", "googlechat:oracle:AAA:BBB", "answer");
    const channel = new GoogleChatChannel({ on() {}, channels: () => [] } as never, {} as never, {} as never);
    (channel as unknown as { pool: { bots: Map<string, unknown> } }).pool.bots.set("oracle", { token: "t", handle: { send: async () => { throw failure; } } });
    const worker = new ReplyDelivery(pending, channel.sendToSession.bind(channel));
    t.after(() => worker.stop());
    worker.kick();
    await until(() => pending.replies()[0]?.attempts === 1);
    return pending.replies()[0];
  };

  const lost = await deliver(new Error("response lost after connection"));
  assert.equal(lost.blocked, true);
  assert.ok(lost.error?.includes("Google Chat send needs inspection"));
  // A 5xx says nothing about whether the message was created.
  assert.equal((await deliver(new GoogleChatApiError(503, "backend error"))).blocked, true);

  assert.equal((await deliver(new GoogleChatApiError(429, "rate limited"))).blocked, false);
  assert.equal((await deliver(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).blocked, false);
});

test("a Google Chat failure before any message is involved can always be retried", async () => {
  const key = { client_email: "app@example.iam.gserviceaccount.com", private_key: (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  // The token endpoint refuses: Chat itself is never asked.
  const refused = new GoogleChatApi(key, (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as never);
  await assert.rejects(refused.createMessage("spaces/AAA", "hi"), (error) => (assert.equal(canRetryChatSend(error), true), true));
  // The token endpoint cannot be reached at all, mid-connection.
  const unreachable = new GoogleChatApi(key, (async () => { throw new TypeError("fetch failed"); }) as never);
  await assert.rejects(unreachable.createMessage("spaces/AAA", "hi"), (error) => (assert.equal(canRetryChatSend(error), true), true));
  // With a token in hand, a lost response to the message itself is not safe to repeat.
  let calls = 0;
  const lost = new GoogleChatApi(key, (async () => {
    if (calls++ === 0) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    throw new TypeError("fetch failed");
  }) as never);
  await assert.rejects(lost.createMessage("spaces/AAA", "hi"), (error) => (assert.equal(canRetryChatSend(error), false), true));
});

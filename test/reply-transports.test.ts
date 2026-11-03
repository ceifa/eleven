import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PendingTurns } from "../src/threads/pending.ts";
import { ReplyDelivery } from "../src/channels/replies.ts";
import { TelegramChannel } from "../src/channels/telegram/index.ts";
import { DiscordChannel } from "../src/channels/discord/index.ts";
import { sendMessage } from "../src/channels/discord/send.ts";
import { DiscordApiError } from "../src/channels/discord/rest.ts";

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
    const telegram = { pool: { get: () => ({ bot: { api: { raw: { sendRichMessage: (payload: { rich_message: { markdown: string } }) => record(payload.rich_message.markdown) } } } }) } };
    const discord = { pool: { get: () => ({ send: (_key: string, text: string, options: Parameters<typeof sendMessage>[3]) =>
      sendMessage({ request: (_method: string, _path: string, request: { body: { content: string } }) => record(request.body.content) } as never, "2", text, options),
    }) } };
    const send = platform === "telegram"
      ? TelegramChannel.prototype.sendToSession.bind(telegram as never)
      : DiscordChannel.prototype.sendToSession.bind(discord as never);
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
    const telegram = { pool: { get: () => ({ bot: { api: { raw: { sendRichMessage: fail } } } }) } };
    const discord = { pool: { get: () => ({ send: fail }) } };
    const send = platform === "telegram"
      ? TelegramChannel.prototype.sendToSession.bind(telegram as never)
      : DiscordChannel.prototype.sendToSession.bind(discord as never);
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

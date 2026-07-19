import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Runner } from "../src/agent/runner.ts";
import { TelegramChannel } from "../src/channels/telegram/index.ts";
import { ThreadStore } from "../src/threads/store.ts";

test("rotated threads are derived as old, not stored as a separate state", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-thread-store-"));
  try {
    const store = new ThreadStore(join(dir, "threads.json"));
    const first = store.rotate("telegram:main:123", "agent");
    const second = store.rotate("telegram:main:123", "agent", first);
    assert.equal(store.isCurrent(first.id), false);
    assert.equal(store.isCurrent(second.id), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("literal outbound messages are appended to the pi transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-outbound-"));
  try {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const file = manager.getSessionFile();
    assert.ok(file);

    const runner = new Runner();
    let disposed = false;
    (runner as unknown as { warm: Map<string, unknown> }).warm.set("thread", {
      session: { dispose: () => { disposed = true; } },
      sessionManager: manager,
      lastUsedAt: Date.now(),
    });
    runner.appendOutbound("thread", file, "openai-codex/gpt-5.6-sol", "operator reply");
    assert.equal(disposed, true);
    assert.equal((runner as unknown as { warm: Map<string, unknown> }).warm.has("thread"), false);
    const entry = SessionManager.open(file).getEntries().at(-1);
    assert.equal(entry?.type, "message");
    if (entry?.type !== "message") return;
    assert.equal(entry.message.role, "assistant");
    assert.deepEqual(entry.message.content, [{ type: "text", text: "operator reply" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram delivery resolves bot, chat and forum topic from a session key", async () => {
  const config = { on() {}, channels: () => [] };
  const telegram = new TelegramChannel(config as never, {} as never);
  const sent: Record<string, unknown>[] = [];
  (telegram as unknown as { bots: Map<string, unknown> }).bots.set("main", {
    token: "test",
    handle: {
      bot: {
        api: {
          raw: {
            sendRichMessage: async (payload: Record<string, unknown>) => {
              sent.push(payload);
              return { message_id: 1 };
            },
          },
        },
      },
    },
  });

  const target = await telegram.sendToSession("telegram:main:-123:topic:45", "**hello**");
  assert.deepEqual(target, { bot: "main", chatId: -123, topic: 45 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, -123);
  assert.equal(sent[0].message_thread_id, 45);
  assert.deepEqual(sent[0].rich_message, { markdown: "**hello**" });
  await assert.rejects(() => telegram.sendToSession("dashboard:agent:123", "hello"), /no Telegram delivery target/);
  await assert.rejects(() => telegram.sendToSession("telegram:missing:123", "hello"), /not running/);
});

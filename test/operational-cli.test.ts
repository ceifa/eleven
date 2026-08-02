import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Runner } from "../src/agent/runner.ts";
import { TelegramChannel } from "../src/channels/telegram/index.ts";
import { readThreadMessages, TOOL_CALLS_ENTRY_TYPE } from "../src/threads/reader.ts";
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

test("threads list most recently active first, with a stable order on ties", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-thread-order-"));
  try {
    const store = new ThreadStore(join(dir, "threads.json"));
    const a = store.rotate("telegram:main:1", "agent");
    const b = store.rotate("telegram:main:2", "agent");
    const c = store.rotate("telegram:main:3", "agent");

    store.update(a.id, { lastActivityAt: 3_000 });
    store.update(b.id, { lastActivityAt: 1_000 });
    store.update(c.id, { lastActivityAt: 2_000 });
    assert.deepEqual(store.list().map((t) => t.id), [a.id, c.id, b.id]);

    // A bump reorders — this is what an arriving message does mid-turn.
    store.update(b.id, { lastActivityAt: 4_000 });
    assert.equal(store.list()[0].id, b.id);

    // Same-millisecond writes must not fall back to insertion order.
    store.update(a.id, { lastActivityAt: 4_000, createdAt: 20 });
    store.update(c.id, { lastActivityAt: 4_000, createdAt: 10 });
    store.update(b.id, { lastActivityAt: 4_000, createdAt: 30 });
    assert.deepEqual(store.list().map((t) => t.id), [b.id, a.id, c.id]);
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

test("recorded nested-runtime tool calls render on the turn's assistant message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-toolcalls-"));
  try {
    const assistant = (text: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "claude-code",
      provider: "claude-code",
      model: "fable",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    });

    // Turn 1 — records written as the calls happen, before the reply lands.
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "fix the test", timestamp: Date.now() });
    manager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [{ id: "claude:0:1", name: "Read", args: { file_path: "/tmp/x.ts" } }] });
    manager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [{ id: "claude:1:2", name: "Bash", args: { command: "npm test" } }] });
    manager.appendMessage(assistant("done"));

    const file = manager.getSessionFile()!;
    const messages = await readThreadMessages(file);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    const reply = messages.at(-1)!;
    assert.equal(reply.text, "done");
    assert.deepEqual(reply.toolCalls?.map((call) => call.name), ["Read", "Bash"]);
    assert.ok(reply.toolCalls?.[0].summary.includes("/tmp/x.ts"));

    // Turn 2 — the legacy shape (one record right after the assistant message)
    // must keep rendering on ITS turn, not leak into a later one.
    manager.appendMessage({ role: "user", content: "and lint it", timestamp: Date.now() });
    manager.appendMessage(assistant("lint is clean"));
    manager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [{ id: "claude:0:9", name: "Bash", args: { command: "npm run lint" } }] });
    const legacy = await readThreadMessages(file);
    assert.deepEqual(legacy.at(-1)?.toolCalls?.map((call) => call.name), ["Bash"]);
    assert.deepEqual(legacy.at(1)?.toolCalls?.map((call) => call.name), ["Read", "Bash"]); // turn 1 untouched

    // Turn 3 — a running (or crashed) turn has records but no assistant message
    // yet: the calls must still show up, as their own transcript row.
    manager.appendMessage({ role: "user", content: "try again", timestamp: Date.now() });
    manager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [{ id: "claude:0:3", name: "Grep", args: {} }] });
    const withOrphan = await readThreadMessages(file);
    const orphan = withOrphan.at(-1)!;
    assert.equal(orphan.role, "assistant");
    assert.equal(orphan.text, "");
    assert.deepEqual(orphan.toolCalls?.map((call) => call.name), ["Grep"]);

    // Re-reading must not duplicate anything — the fold works on copies, never
    // on the shared cache.
    const again = await readThreadMessages(file);
    assert.deepEqual(again.at(1)?.toolCalls?.length, 2);
    assert.deepEqual(again.at(-1)?.toolCalls?.length, 1);
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

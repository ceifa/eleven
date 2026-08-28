import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listWorkspaceSkills, Runner } from "../src/agent/runner.ts";
import { TelegramChannel } from "../src/channels/telegram/index.ts";
import { conversationIdentity } from "../src/threads/conversation.ts";
import { readThreadTimeline, TOOL_CALLS_ENTRY_TYPE, TURN_ERROR_ENTRY_TYPE } from "../src/threads/reader.ts";
import { ThreadStore } from "../src/threads/store.ts";
import { readJsonFile } from "../src/util.ts";

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
    runner.appendOutbound("thread", { sessionFile: file, sessionDir: dir, workspacePath: dir }, "openai-codex/gpt-5.6-sol", "operator reply");
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

test("a destination that only ever receives output gets its session materialized", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-outbound-no-session-"));
  try {
    // A Telegram topic the agent writes to but nobody ever replies in: the
    // thread record exists with sessionFile unset, and delivery used to be
    // refused outright ("thread has no session file"), which silently pushed
    // the health route to a DM.
    const runner = new Runner();
    const file = runner.appendOutbound(
      "thread",
      { sessionDir: join(dir, "sessions"), workspacePath: dir },
      "openai-codex/gpt-5.6-sol",
      "operator reply",
    );
    assert.ok(existsSync(file), "the session file must exist on disk after the append");
    const entry = SessionManager.open(file).getEntries().at(-1);
    assert.equal(entry?.type, "message");
    if (entry?.type !== "message") return;
    assert.equal(entry.message.role, "assistant");
    assert.deepEqual(entry.message.content, [{ type: "text", text: "operator reply" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbound delivery on a promised-but-missing session keeps the session id", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-outbound-promised-"));
  try {
    // The daemon died before pi wrote the first-turn JSONL: the filename is the
    // only surviving link to Claude's durable state, so the id must be reused
    // instead of a second fresh session being forked.
    const id = "3f1c9d02-5b7a-4c31-9e2f-8a6d4b0c17e5";
    const promised = join(dir, "sessions", `2026-08-18_${id}.jsonl`);
    const runner = new Runner();
    const file = runner.appendOutbound(
      "thread",
      { sessionFile: promised, sessionDir: join(dir, "sessions"), workspacePath: dir },
      "openai-codex/gpt-5.6-sol",
      "operator reply",
    );
    assert.equal(SessionManager.open(file).getSessionId(), id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the transcript renders tool calls as their own rows, in the order they happened", async () => {
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
    const timeline = await readThreadTimeline(file);
    // The calls happened before the reply, so they render before it — and the
    // consecutive records merge into a single block.
    assert.deepEqual(timeline.map((item) => item.kind), ["message", "tool-calls", "message"]);
    const calls = timeline[1];
    assert.equal(calls.kind, "tool-calls");
    if (calls.kind !== "tool-calls") return;
    assert.deepEqual(calls.calls.map((call) => call.name), ["Read", "Bash"]);
    assert.ok(calls.calls[0].summary.includes("/tmp/x.ts"));
    assert.deepEqual(timeline.at(-1), { kind: "message", role: "assistant", text: "done", timestamp: timeline.at(-1)!.timestamp });

    // Turn 2 — the legacy shape (one record written right after the assistant
    // message) still renders, in the position the file gives it.
    manager.appendMessage({ role: "user", content: "and lint it", timestamp: Date.now() });
    manager.appendMessage(assistant("lint is clean"));
    manager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [{ id: "claude:0:9", name: "Bash", args: { command: "npm run lint" } }] });
    const legacy = await readThreadTimeline(file);
    assert.deepEqual(legacy.slice(3).map((item) => item.kind), ["message", "message", "tool-calls"]);
    assert.deepEqual(legacy.slice(0, 3).map((item) => item.kind), ["message", "tool-calls", "message"]); // turn 1 untouched

    // Turn 3 — a running (or crashed) turn has records but no assistant message
    // yet: the calls must still show up.
    manager.appendMessage({ role: "user", content: "try again", timestamp: Date.now() });
    manager.appendCustomEntry(TOOL_CALLS_ENTRY_TYPE, { calls: [{ id: "claude:0:3", name: "Grep", args: {} }] });
    const running = await readThreadTimeline(file);
    const orphan = running.at(-1)!;
    assert.equal(orphan.kind, "tool-calls");
    if (orphan.kind !== "tool-calls") return;
    assert.deepEqual(orphan.calls.map((call) => call.name), ["Grep"]);

    // Re-reading must not duplicate anything — rows own fresh arrays, the parsed
    // entries behind them are cached and shared.
    const again = await readThreadTimeline(file);
    assert.deepEqual(again.map((item) => item.kind), running.map((item) => item.kind));
    assert.equal(again[1].kind === "tool-calls" && again[1].calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn that failed stays in the transcript, where it failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-turn-error-"));
  try {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "how did it go?", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fine" }],
      api: "claude-code",
      provider: "claude-code",
      model: "fable",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    manager.appendMessage({ role: "user", content: "summarize the deploy", timestamp: Date.now() });
    manager.appendCustomEntry(TURN_ERROR_ENTRY_TYPE, { message: "provider error on openai/gpt-5.5: 429 rate limited" });
    const file = manager.getSessionFile()!;

    const timeline = await readThreadTimeline(file);
    assert.deepEqual(timeline.map((item) => item.kind), ["message", "message", "message", "error"]);
    const failure = timeline.at(-1)!;
    assert.equal(failure.kind, "error");
    if (failure.kind !== "error") return;
    assert.equal(failure.text, "provider error on openai/gpt-5.5: 429 rate limited");
    assert.ok(failure.timestamp);

    // The next turn goes on top of it: a failure ends a turn, not a thread.
    manager.appendMessage({ role: "user", content: "try again", timestamp: Date.now() });
    const retried = await readThreadTimeline(file);
    assert.deepEqual(retried.map((item) => item.kind), ["message", "message", "message", "error", "message"]);

    // An entry with no message is a record of nothing — it must not render as
    // an empty red row.
    manager.appendCustomEntry(TURN_ERROR_ENTRY_TYPE, {});
    assert.deepEqual((await readThreadTimeline(file)).map((item) => item.kind), retried.map((item) => item.kind));
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

test("a conversation is named by its topic, then its group, then the person", () => {
  const channels = [
    {
      type: "telegram" as const,
      name: "main",
      token: "t",
      users: { "42": { name: "Gabriel" }, "43": { username: "ceifa" } },
      groups: {
        "-100": { title: "Sesh", topics: { "7": { title: "eleven" } } },
        "-200": {},
      },
    },
  ];

  assert.deepEqual(conversationIdentity("telegram:main:-100:topic:7", channels), {
    name: "eleven",
    context: "Sesh",
    label: "Telegram · Sesh · eleven",
  });
  assert.deepEqual(conversationIdentity("telegram:main:-100", channels), {
    name: "Sesh",
    context: "Telegram",
    label: "Telegram · Sesh",
  });
  assert.equal(conversationIdentity("telegram:main:42", channels).name, "Gabriel");
  assert.equal(conversationIdentity("telegram:main:43", channels).name, "@ceifa");
  assert.equal(conversationIdentity("dashboard:agent:uuid", channels).name, "Dashboard");
  assert.equal(conversationIdentity("cli:agent:uuid", channels).name, "CLI");

  // Nothing is invented when the registry hasn't learned a name yet: the raw id
  // still identifies the chat, "unknown" would not.
  assert.equal(conversationIdentity("telegram:main:-100:topic:9", channels).name, "topic 9");
  assert.equal(conversationIdentity("telegram:main:-200", channels).name, "-200");
  assert.equal(conversationIdentity("telegram:main:44", channels).name, "44");
  assert.equal(conversationIdentity("telegram:gone:-100:topic:7", channels).name, "topic 7");
});

test("stopping a thread from outside Telegram also drops its buffered input", () => {
  const config = { on() {}, channels: () => [] };
  const telegram = new TelegramChannel(config as never, {} as never);
  const discarded: string[] = [];
  (telegram as unknown as { bots: Map<string, unknown> }).bots.set("main", {
    token: "test",
    handle: { discardBurst: (sessionKey: string) => (discarded.push(sessionKey), true) },
  });

  assert.equal(telegram.discardPending("telegram:main:-123:topic:45"), true);
  assert.deepEqual(discarded, ["telegram:main:-123:topic:45"]);
  // A thread with no Telegram bot behind it has nothing buffered to drop.
  assert.equal(telegram.discardPending("dashboard:agent:123"), false);
  assert.equal(telegram.discardPending("telegram:missing:1"), false);
  assert.equal(discarded.length, 1);
});

// --- silent-failure regressions: a read that fails is not a read that found nothing ---

test("state files tell a missing file apart from an unreadable one", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-state-read-"));
  try {
    const fallback = { version: 1, threads: {}, current: {} };
    // Missing is the normal case: a fresh install has no state file yet.
    assert.deepEqual(readJsonFile(join(dir, "absent.json"), fallback), fallback);

    // A real read failure must not be laundered into the fallback. Reading a
    // directory raises EISDIR here; in the wild it is EACCES or EIO. Either way
    // the old code answered "empty", and the store's next write persisted that
    // emptiness over the real thread index. (Pointing at a path under a regular
    // file covers the ENOTDIR shape of the same branch.)
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify(fallback));
    assert.throws(() => readJsonFile(dir, fallback), /Could not read/);
    assert.throws(() => readJsonFile(join(file, "nested.json"), fallback), /Could not read/);

    // Unparsable content is a fault too, not an empty store.
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    assert.throws(() => readJsonFile(corrupt, fallback), /Could not parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable session raises instead of rendering as an empty thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-session-read-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "");
    // A session that was deleted legitimately has no timeline.
    assert.deepEqual(await readThreadTimeline(join(dir, "gone.jsonl")), []);
    // One that cannot be stat'ed at all is a fault — reporting "no history"
    // hides it and reads as a transcript that failed to record.
    await assert.rejects(() => readThreadTimeline(join(file, "nested.jsonl")), /Could not read session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a skill directory that cannot be enumerated is reported, not silently dropped", {
  // chmod cannot lock root out of a directory, so the fault is unreproducible there.
  skip: process.getuid?.() === 0 ? "requires a non-root user" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-skill-scan-"));
  const blocked = join(dir, "context");
  try {
    mkdirSync(join(blocked, ".agents", "skills"), { recursive: true });
    chmodSync(blocked, 0o000);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      await listWorkspaceSkills(dir);
    } finally {
      console.warn = realWarn;
    }
    // The walk still returns — losing a subtree must not fail a turn — but the
    // loss now leaves a trace instead of being cached away for a minute.
    assert.ok(
      warnings.some((line) => line.includes("skill scan") && line.includes(blocked)),
      `expected a skill-scan warning naming ${blocked}, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    chmodSync(blocked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { formatTelegramInboundPrompt, syncTelegramCommands } from "../src/channels/telegram/bot.ts";
import { renderTaskActivity, TelegramTaskProgress } from "../src/channels/telegram/task-progress.ts";

test("Telegram command sync removes stale group-scoped commands", async () => {
  const calls: Array<{ method: string; value: unknown }> = [];
  const api = {
    setMyCommands: async (commands: unknown) => {
      calls.push({ method: "set", value: commands });
      return true as const;
    },
    deleteMyCommands: async (options: unknown) => {
      calls.push({ method: "delete", value: options });
      return true as const;
    },
  };

  await syncTelegramCommands(api as never);

  assert.deepEqual(calls, [
    {
      method: "set",
      value: [
        { command: "new", description: "Start a fresh thread" },
        { command: "skills", description: "List the skills the agent can use here" },
        { command: "usage", description: "Show model subscription usage" },
        { command: "stop", description: "Abort the running turn" },
      ],
    },
    { method: "delete", value: { scope: { type: "all_group_chats" } } },
  ]);
});

test("Telegram task progress renders plan and agent lifecycle compactly", () => {
  const text = renderTaskActivity(
    [
      { id: "1", title: "Inspect adapter", status: "completed" },
      { id: "2", title: "Wire Telegram", status: "running" },
      { id: "3", title: "Tests", status: "pending", blockedBy: ["2"] },
    ],
    [
      { id: "a", title: "Review reuse", status: "completed", summary: "Found one duplicate", usage: { durationMs: 7200 } },
      { id: "b", title: "Check efficiency", status: "running", lastToolName: "Grep", usage: { totalTokens: 1400 } },
    ],
  );
  assert.equal(text, [
    "⚙️ Agent working",
    "",
    "📋 Plan",
    "✅ Inspect adapter",
    "⏳ Wire Telegram",
    "⏸ Tests · blocked by #2",
    "",
    "🤖 Agents",
    "✅ Review reuse · 7s · Found one duplicate",
    "⏳ Check efficiency · Grep · 1.4k tok",
  ].join("\n"));
});

/** Fake bot API recording every raw call; messages are created with id 77. */
function fakeApi() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api = {
    raw: {
      sendMessage: async (payload: Record<string, unknown>) => {
        calls.push({ method: "send", payload });
        return { message_id: 77 };
      },
      editMessageText: async (payload: Record<string, unknown>) => {
        calls.push({ method: "edit", payload });
        return true;
      },
      deleteMessage: async (payload: Record<string, unknown>) => {
        calls.push({ method: "delete", payload });
        return true;
      },
    },
  };
  return { calls, api: api as never };
}

test("Telegram task progress sends once then edits the same quiet message", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, -100, 42, { message_id: 9 });
  progress.update({ kind: "agent", task: { id: "a", title: "Review", status: "running" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  progress.update({ kind: "agent", task: { id: "a", title: "Review", status: "completed" } });
  await progress.finish("completed");
  progress.cancel();

  assert.deepEqual(calls.map((call) => call.method), ["send", "edit"]);
  assert.equal(calls[0]?.payload.disable_notification, true);
  assert.deepEqual(calls[0]?.payload.reply_parameters, { message_id: 9 });
  assert.equal(calls[1]?.payload.message_id, 77);
  assert.match(String(calls[1]?.payload.text), /✅ Turn completed/);
});

test("Telegram task progress terminalizes running agents when stopped", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, 1);
  progress.update({ kind: "agent", task: { id: "a", title: "Long review", status: "running" } });
  await progress.finish("stopped");
  progress.cancel();

  assert.deepEqual(calls.map((call) => call.method), ["send"]);
  assert.match(String(calls[0]?.payload.text), /⏹ Turn stopped/);
  assert.match(String(calls[0]?.payload.text), /⏹ Long review/);
  assert.equal(renderTaskActivity([], [], "completed"), "✅ Turn completed");
});

test("running header shows the current top-level tool and elapsed time", () => {
  assert.equal(
    renderTaskActivity([], [], undefined, { tool: { name: "Bash", summary: "npm test" }, elapsedMs: 65_000 }),
    "⚙️ Agent working · 1m05s\n🔧 Bash · npm test",
  );
  // Elapsed time stays quiet while the turn still feels instant.
  assert.equal(
    renderTaskActivity([], [], undefined, { tool: { name: "Read" }, elapsedMs: 400 }),
    "⚙️ Agent working\n🔧 Read",
  );
  // Finished renders never carry the live tool line.
  assert.equal(renderTaskActivity([], [], "completed", undefined), "✅ Turn completed");
});

test("quick tool-only turns never post a status message", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, 1);
  progress.tool("Bash", "npm test");
  // finish() lands before the tool-only render hold-off expires.
  await progress.finish("completed");
  progress.cancel();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(calls, []);
});

test("a tool-status-only message is deleted when the turn ends", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, 7, undefined, undefined, 30);
  progress.tool("Bash", "npm test");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await progress.finish("completed");
  progress.cancel();
  // The cleanup delete deliberately runs off the reply's critical path.
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls.map((call) => call.method), ["send", "delete"]);
  assert.match(String(calls[0]?.payload.text), /🔧 Bash · npm test/);
  assert.equal(calls[1]?.payload.message_id, 77);
});

test("group attribution wraps the complete inbound body while DMs stay bare", () => {
  const group = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: { from: { id: 42, first_name: "Gabriel", username: "c3if4" } },
  };
  const body = "[Transcript]\nLet's go in October.";

  assert.equal(formatTelegramInboundPrompt(group as never, body), "[Gabriel @c3if4]\n[Transcript]\nLet's go in October.");
  assert.equal(formatTelegramInboundPrompt({ chat: { type: "private" } } as never, body), body);
});

test("Telegram reply context prefers the selected quote", () => {
  const ctx = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: {
      from: { id: 42, first_name: "Gabriel", username: "c3if4" },
      quote: { text: "the hotel in September costs $4,800", position: 20, is_manual: true },
      reply_to_message: {
        from: { id: 43, first_name: "Samara", last_name: "Lana" },
        text: "A much longer original message that contains the selected excerpt.",
      },
    },
  };

  assert.equal(
    formatTelegramInboundPrompt(ctx as never, "Did you consider this?"),
    '[Gabriel @c3if4]\n[Replying to Samara Lana: "the hotel in September costs $4,800"]\nDid you consider this?',
  );
});

test("long implicit reply quotes keep a compact head and tail", () => {
  const original = `${"A".repeat(130)} middle ${"Z".repeat(80)}`;
  const ctx = {
    chat: { type: "group" },
    me: { id: 999 },
    message: {
      from: { id: 42, first_name: "Gabriel" },
      reply_to_message: { from: { id: 43, first_name: "Samara" }, text: original },
    },
  };

  assert.equal(
    formatTelegramInboundPrompt(ctx as never, "Agreed."),
    `[Gabriel]\n[Replying to Samara: "${"A".repeat(120)}…${"Z".repeat(70)}"]\nAgreed.`,
  );
});

test("media replies identify the bot as you without copying ids", () => {
  const ctx = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: {
      from: { id: 42, first_name: "Gabriel" },
      reply_to_message: { from: { id: 999, first_name: "Mortar", is_bot: true }, photo: [{}] },
    },
  };

  assert.equal(
    formatTelegramInboundPrompt(ctx as never, "This one."),
    "[Gabriel]\n[Replying to your photo]\nThis one.",
  );
});

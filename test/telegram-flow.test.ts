import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { Bot } from "grammy";
import type { ChannelConfig } from "../src/config.ts";
import type { IncomingMessage } from "../src/gateway.ts";

/* The Telegram bot from the update it receives to the reply it queues, with
   Telegram's API and the gateway both answered here: what a message becomes on
   its way to a turn (which conversation, under whose instructions and models,
   with which tools), and what the chat is told meanwhile. */

const stateDir = mkdtempSync(join(tmpdir(), "eleven-telegram-flow-"));
process.env.ELEVEN_STATE_DIR = stateDir;
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { startTelegramBot } = await import("../src/channels/telegram/bot.ts");

const ME = { id: 999, is_bot: true as const, first_name: "Mortar", username: "mortar_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };

async function until(check: () => boolean, what: string) {
  const end = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < end, `${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function harness(t: TestContext, config: ChannelConfig) {
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const bot = new Bot("1:test", { botInfo: ME as never });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    // The poller: nothing ever arrives that way here.
    if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, result: [] } as never;
    }
    if (method === "getMe") return { ok: true, result: ME } as never;
    return { ok: true, result: method.startsWith("send") ? { message_id: 500 + calls.length } : true } as never;
  });

  const turns: IncomingMessage[] = [];
  const queued: { threadId: string; sessionKey: string; text: string; replyTo?: string }[] = [];
  const interrupted: string[] = [];
  const knocks: Record<string, unknown>[] = [];
  let answer: (incoming: IncomingMessage) => Promise<string> = async () => "pong";
  const gateway = {
    handle: async (incoming: IncomingMessage) => {
      turns.push(incoming);
      const text = await answer(incoming);
      const result = { sessionFile: "session.jsonl", text, model: "claude-code/opus", status: "completed" as const };
      await incoming.deliver?.(result, "thread-1");
      return result;
    },
    hasPendingReply: () => false,
    queueReply: (threadId: string, sessionKey: string, text: string, replyTo?: string) => queued.push({ threadId, sessionKey, text, replyTo }),
    interrupt: async (sessionKey: string) => (interrupted.push(sessionKey), false),
  };
  const pairing = {
    find: () => undefined,
    request: (input: Record<string, unknown>) => {
      knocks.push(input);
      return { request: { ...input, id: "abc", createdAt: 0 }, isNew: true };
    },
  };
  const handle = startTelegramBot("main", "1:test", {
    gateway: gateway as never,
    pairing: pairing as never,
    botConfig: () => config,
    workspace: () => "agent",
    transcribeCommand: () => undefined,
    autoFailover: () => false,
    updateGroup: (id, mutate) => { mutate(config.groups![id]!); },
    updateUser: (id, mutate) => { if (config.users?.[id]) mutate(config.users[id]!); },
  }, { bot });
  t.after(() => handle.stop());
  // Updates only flow once the bot knows who it is.
  const ready = until(() => handle.username !== undefined, "the bot's startup");

  let updateId = 1;
  const message = async (fields: Record<string, unknown>) => (await ready, bot.handleUpdate({ update_id: updateId++, message: { date: 0, ...fields } } as never));
  const sent = () => calls.filter((call) => call.method === "sendRichMessage").map((call) => call.payload);
  return { handle, ready, calls, turns, queued, interrupted, knocks, message, sent, setAnswer: (next: typeof answer) => { answer = next; } };
}

const gabriel = { id: 42, is_bot: false, first_name: "Gabriel", username: "c3if4" };

test("a DM becomes a turn in the person's conversation, and its answer is queued for delivery", async (t) => {
  const config: ChannelConfig = { type: "telegram", name: "main", token: "t", users: { "42": { name: "Old Name", appendSystemPrompt: "be brief", models: [{ model: "claude-code/sonnet" }] } } };
  const { calls, turns, queued, message } = harness(t, config);

  await message({ message_id: 7, chat: { id: 42, type: "private", first_name: "Gabriel" }, from: gabriel, text: "hello" });
  // The receipt is acked at once; the turn waits out the burst window.
  await until(() => calls.some((call) => call.method === "setMessageReaction"), "the ack reaction");
  assert.equal(turns.length, 0);
  await until(() => queued.length === 1, "the turn");

  const [turn] = turns;
  assert.equal(turn.sessionKey, "telegram:main:42");
  assert.equal(turn.text, "hello"); // a DM needs no sender attribution
  assert.equal(turn.workspaceHint, "agent");
  assert.equal(turn.runtime.channel, "telegram");
  // The name healed from the message before the turn described the conversation.
  assert.equal(config.users!["42"]!.name, "Gabriel");
  assert.equal(turn.runtime.conversation, "DM with Gabriel (@c3if4)");
  assert.deepEqual(turn.appends, ["be brief"]);
  assert.deepEqual(turn.modelScopes?.find((scope) => scope?.models)?.models, [{ model: "claude-code/sonnet" }]);
  assert.deepEqual(turn.customTools?.map((tool) => tool.name), ["telegram"]);
  assert.equal(typeof turn.createBackground, "function");

  // The final answer goes to the durable ledger, addressed to the message that asked.
  assert.deepEqual(queued, [{ threadId: "thread-1", sessionKey: "telegram:main:42", text: "pong", replyTo: "7" }]);
  await until(() => calls.some((call) => call.method === "sendChatAction" && call.payload.chat_id === 42), "the typing indicator");
});

test("a conversation keeps one tool object across turns, so its warm session is reused", async (t) => {
  const { turns, queued, message } = harness(t, { type: "telegram", name: "main", token: "t", users: { "42": {} } });
  await message({ message_id: 1, chat: { id: 42, type: "private" }, from: gabriel, text: "one" });
  await until(() => queued.length === 1, "the first turn");
  await message({ message_id: 2, chat: { id: 42, type: "private" }, from: gabriel, text: "two" });
  await until(() => queued.length === 2, "the second turn");
  assert.equal(turns[0].customTools![0], turns[1].customTools![0]);
});

test("a forum topic is its own conversation, under the group's instructions and then the topic's", async (t) => {
  const config: ChannelConfig = {
    type: "telegram", name: "main", token: "t",
    users: { "42": {} },
    groups: { "-100": { requireMention: false, title: "Lab", appendSystemPrompt: "group rules", models: [{ model: "claude-code/opus" }], topics: { "7": { title: "ops", appendSystemPrompt: "topic rules", models: [{ model: "claude-code/haiku" }] } } } },
  };
  const { turns, queued, message, sent, setAnswer } = harness(t, config);
  setAnswer(async () => { throw new Error("provider down"); });

  await message({ message_id: 9, message_thread_id: 7, is_topic_message: true, chat: { id: -100, type: "supergroup", title: "Lab" }, from: gabriel, text: "status?" });
  await until(() => turns.length === 1, "the turn");

  const [turn] = turns;
  assert.equal(turn.sessionKey, "telegram:main:-100:topic:7");
  assert.equal(turn.text, "[Gabriel @c3if4]\nstatus?");
  assert.equal(turn.runtime.conversation, 'group "Lab", topic "ops"');
  assert.deepEqual(turn.appends, ["group rules", "topic rules"]);
  // Most specific first: the topic's models win over the group's.
  assert.deepEqual(turn.modelScopes?.find((scope) => scope?.models)?.models, [{ model: "claude-code/haiku" }]);

  // A turn that fails says so in the topic it failed in, and queues nothing.
  await until(() => sent().some((payload) => String(payload.rich_message.markdown).includes("provider down")), "the failure notice");
  const notice = sent().find((payload) => String(payload.rich_message.markdown).includes("provider down"))!;
  assert.equal(notice.chat_id, -100);
  assert.equal(notice.message_thread_id, 7);
  assert.equal(queued.length, 0);
});

test("a group only hears its allowed users, and only when it is addressed", async (t) => {
  const config: ChannelConfig = { type: "telegram", name: "main", token: "t", users: { "42": {} }, groups: { "-100": { title: "Lab" } } };
  const { turns, queued, knocks, message } = harness(t, config);
  const chat = { id: -100, type: "supergroup", title: "Lab" };

  await message({ message_id: 1, chat, from: gabriel, text: "talking among ourselves" });
  await message({ message_id: 2, chat, from: { id: 77, is_bot: false, first_name: "Stranger" }, text: "@mortar_bot hi" });
  await message({ message_id: 3, chat, from: gabriel, text: "@mortar_bot ping" });
  // A reply to one of the bot's own messages is talking to it too.
  await message({ message_id: 4, chat, from: gabriel, text: "and this?", reply_to_message: { message_id: 90, date: 0, chat, from: ME, text: "earlier answer" } });
  await message({ message_id: 5, chat, from: gabriel, text: "not this", reply_to_message: { message_id: 91, date: 0, chat, from: { id: 77, is_bot: false, first_name: "Stranger" }, text: "x" } });
  await until(() => queued.length === 1, "the addressed messages' turn");
  assert.deepEqual(turns.map((turn) => turn.text), ['[Gabriel @c3if4]\n@mortar_bot ping\n\n[Gabriel @c3if4]\n[Replying to you: "earlier answer"]\nand this?']);
  // A stranger inside a registered group is ignored, not offered a pairing.
  assert.equal(knocks.length, 0);
});

test("a stranger's DM becomes one pairing request and a notice, never a turn", async (t) => {
  const { turns, knocks, message, sent } = harness(t, { type: "telegram", name: "main", token: "t", users: {} });
  await message({ message_id: 1, chat: { id: 77, type: "private" }, from: { id: 77, is_bot: false, first_name: "T\u{1D68E}\u{1D425}\u{1D68E}gram", username: "who" }, text: "let me in" });
  await until(() => sent().length === 1, "the notice");
  assert.equal(knocks.length, 1);
  assert.deepEqual(
    { kind: knocks[0].kind, bot: knocks[0].bot, userId: knocks[0].userId, chatId: knocks[0].chatId, username: knocks[0].username, name: knocks[0].name, disguised: knocks[0].disguised },
    { kind: "dm", bot: "main", userId: "77", chatId: "77", username: "who", name: "Telegram", disguised: true },
  );
  assert.match(String(sent()[0].rich_message.markdown), /This bot is private/);
  assert.equal(turns.length, 0);
});

test("/stop is answered by the bot itself and drops what was buffered", async (t) => {
  const { turns, interrupted, message, sent } = harness(t, { type: "telegram", name: "main", token: "t", users: { "42": {} } });
  const chat = { id: 42, type: "private" };
  await message({ message_id: 1, chat, from: gabriel, text: "do something long" });
  await message({ message_id: 2, chat, from: gabriel, text: "/stop" });
  await until(() => sent().length === 1, "the command's answer");
  assert.deepEqual(interrupted, ["telegram:main:42"]);
  assert.match(String(sent()[0].rich_message.markdown), /Stopped/); // the buffered message counted
  assert.equal(sent()[0].reply_parameters.message_id, 2);
  // The buffered message never becomes a turn.
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(turns.length, 0);
});

test("a wake-up runs in the conversation its session key names, pinned to the thread it was for", async (t) => {
  const { handle, ready, turns, queued } = harness(t, { type: "telegram", name: "main", token: "t", users: { "42": { name: "Gabriel" } } });
  await ready;
  await handle.wake("telegram:main:42", "the job you started finished", "thread-9");
  assert.equal(turns[0].sessionKey, "telegram:main:42");
  assert.equal(turns[0].text, "the job you started finished");
  assert.equal(turns[0].expectedThreadId, "thread-9");
  assert.equal(queued[0].replyTo, undefined); // nothing triggered it, so nothing to thread onto
  await assert.rejects(() => handle.wake("telegram:other:42"), /cannot wake telegram:other:42/);
  await assert.rejects(() => handle.wake("discord:main:dm:42"), /cannot wake/);
});

test("literal text goes to the chat and topic a session key names", async (t) => {
  const { handle, ready, sent } = harness(t, { type: "telegram", name: "main", token: "t", users: {} });
  await ready;
  await handle.send("telegram:main:-100:topic:7", "**hello**", { replyTo: "31" });
  assert.equal(sent()[0].chat_id, -100);
  assert.equal(sent()[0].message_thread_id, 7);
  assert.deepEqual(sent()[0].rich_message, { markdown: "**hello**" });
  assert.equal(sent()[0].reply_parameters.message_id, 31);
  assert.deepEqual(handle.status(), { username: "mortar_bot", connected: true });
});

import assert from "node:assert/strict";
import test from "node:test";
import { InputFile } from "grammy";
import { createSeenMessages, foldDisplayName, formatTelegramInboundPrompt, registerTopic, syncTelegramCommands, topicEntry } from "../src/channels/telegram/bot.ts";
import { sendRich, splitRich } from "../src/channels/telegram/rich.ts";
import { disableKeyboard, telegramTool } from "../src/channels/telegram/tool.ts";
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
      // No is_ephemeral: an ephemeral command never becomes a message in the
      // chat, and Telegram replayed a whole day of them in one burst — fourteen
      // /new in eleven seconds, each rotating a live conversation. As ordinary
      // messages they carry a message id, which is what the dedupe below needs.
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
    [{
      tasks: [
        { id: "1", title: "Inspect adapter", status: "completed" },
        { id: "2", title: "Wire Telegram", status: "running" },
        { id: "3", title: "Tests", status: "pending", blockedBy: ["2"] },
      ],
    }],
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

test("a producer's rows are their own section, under its own name", () => {
  // Regression: scope existed for correctness (one snapshot must not evict
  // another) but was ignored when rendering, so a workflow's internal phases
  // sat in the user's plan as if they were tasks the user asked for.
  const text = renderTaskActivity(
    [
      { tasks: [{ id: "1", title: "Ship it", status: "running" }] },
      { label: "workflow", tasks: [{ id: "w:phase-0", title: "scout", status: "completed" }] },
    ],
    [],
  );
  assert.equal(text, [
    "⚙️ Agent working",
    "",
    "📋 Plan",
    "⏳ Ship it",
    "",
    "📋 workflow",
    "✅ scout",
  ].join("\n"));
});

test("the hidden-row count is how many exist, not how many arrived", () => {
  // Regression: a fan-out caps the rows it sends (10), the section shows 8, and
  // the count was computed from what arrived — so 40 agents rendered as
  // "… 2 more". The producer reports its real total; that is what counts.
  const agents = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, title: `agent ${i}`, status: "completed" as const }));
  const text = renderTaskActivity([], agents, undefined, undefined, undefined, 40);
  assert.match(text, /… 32 more/);
  // Without a reported total it still degrades to counting the rows it has.
  assert.match(renderTaskActivity([], agents), /… 2 more/);
});

test("a blocker id is shown without the scope it was namespaced with", () => {
  const text = renderTaskActivity(
    [{ label: "workflow", tasks: [{ id: "call-7:p2", title: "dig", status: "pending", blockedBy: ["call-7:p1"] }] }],
    [],
  );
  assert.match(text, /blocked by #p1$/m);
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
  const progress = new TelegramTaskProgress(api, -100, { topic: 42, replyParameters: { message_id: 9 }, throttleMs: 200 });
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
  const progress = new TelegramTaskProgress(api, 7, { toolRenderDelayMs: 30 });
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

test("a turn that produces no event at all still reports that it is working", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, 5, { idleRenderDelayMs: 30 });
  progress.start();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(calls.map((call) => call.method), ["send"]);
  assert.equal(String(calls[0]?.payload.text), "\u2699\ufe0f Agent working");

  // Still only status: the reply that follows supersedes it.
  await progress.finish("completed");
  progress.cancel();
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.map((call) => call.method), ["send", "delete"]);
});

test("a provider retry is announced live and kept after the turn", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, 5);
  progress.retry({ attempt: 1, maxAttempts: 3, errorMessage: "API Error: 529 Overloaded" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await progress.finish("completed");
  progress.cancel();

  // No delete: why a turn went quiet for minutes outlives the turn.
  assert.deepEqual(calls.map((call) => call.method), ["send", "edit"]);
  assert.match(String(calls[0]?.payload.text), /^\u2699\ufe0f Agent working\n\ud83d\udd01 Retry 1\/3 \u00b7 API Error: 529 Overloaded$/);
  assert.match(String(calls[1]?.payload.text), /\u2705 Turn completed\n\ud83d\udd01 Retry 1\/3/);
});

test("in a group the status is one message, sent once and edited in place", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, -101, { toolRenderDelayMs: 30, throttleMs: 200 });
  progress.tool("Bash", "npm test");
  await new Promise((resolve) => setTimeout(resolve, 150));
  progress.update({ kind: "agent", task: { id: "a", title: "Review", status: "running" } });
  await new Promise((resolve) => setTimeout(resolve, 950));
  await progress.finish("completed");
  progress.cancel();

  assert.deepEqual(calls.map((call) => call.method), ["send", "edit", "edit"]);
  assert.equal(calls[0]?.payload.chat_id, -101);
  assert.equal(calls[1]?.payload.message_id, 77);
});

test("two turns in one chat share a single edit budget", async () => {
  // Regression: the cadence was per card, so two turns in the same group wrote
  // at twice the rate — which is how a pair of concurrent turns earned a 429 and
  // ended up with the status disabled for that chat entirely.
  const { calls, api } = fakeApi();
  const options = { toolRenderDelayMs: 0, throttleMs: 300 };
  const first = new TelegramTaskProgress(api, -102, options);
  const second = new TelegramTaskProgress(api, -102, options);
  const at: number[] = [];
  const started = Date.now();
  first.update({ kind: "plan", tasks: [{ id: "1", title: "Ship it", status: "running" }] });
  second.update({ kind: "plan", tasks: [{ id: "2", title: "Ship it too", status: "running" }] });
  for (let i = 0; i < 200 && calls.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    while (calls.length > at.length) at.push(Date.now() - started);
  }
  first.cancel();
  second.cancel();

  assert.equal(calls.length, 2);
  assert.ok(at[1]! - at[0]! >= 250, `the second card wrote ${at[1]! - at[0]!}ms after the first`);
});

test("an infinite hold-off keeps tool status off the chat until real tasks appear", async () => {
  const { calls, api } = fakeApi();
  const progress = new TelegramTaskProgress(api, 1, { toolRenderDelayMs: Infinity, idleRenderDelayMs: Infinity });
  progress.start();
  progress.tool("Bash", "npm test");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(calls, []);

  // Plan content is a record of the turn, not scaffolding — it still posts.
  progress.update({ kind: "plan", tasks: [{ id: "1", title: "Ship it", status: "running" }] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  progress.cancel();
  assert.deepEqual(calls.map((call) => call.method), ["send"]);
  assert.match(String(calls[0]?.payload.text), /Ship it/);
});

test("a DM gets the same status a group does", async () => {
  const { calls, api } = fakeApi();
  // A private chat (positive id) is where the status used to be suppressed in
  // favour of a draft preview.
  const progress = new TelegramTaskProgress(api, 4242, { toolRenderDelayMs: 30 });
  progress.tool("Bash", "npm test");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await progress.finish("completed");
  progress.cancel();
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls.map((call) => call.method), ["send", "delete"]);
  assert.match(String(calls[0]?.payload.text), /🔧 Bash · npm test/);
});

/** Fake API for the channel tool: records rich sends and the classic media
 * methods. `rejectRich` plays a chat where embedded media isn't accepted. */
function fakeToolApi(options: { rejectRich?: boolean } = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api = {
    raw: {
      sendRichMessage: async (payload: Record<string, unknown>) => {
        calls.push({ method: "rich", payload });
        if (options.rejectRich) throw new Error("Bad Request: MEDIA_INVALID");
        return { message_id: 12 };
      },
    },
    sendPhoto: async (_chat: number, file: unknown, rest: Record<string, unknown>) => {
      calls.push({ method: "photo", payload: { file, ...rest } });
      return { message_id: 13 };
    },
    sendVoice: async (_chat: number, file: unknown, rest: Record<string, unknown>) => {
      calls.push({ method: "voice", payload: { file, ...rest } });
      return { message_id: 14 };
    },
  };
  return { calls, tool: telegramTool(api as never, 5) };
}

test("media rides inside the message, so the text is not cut down to a caption", async () => {
  const { calls, tool } = fakeToolApi();
  const text = "x".repeat(2_000);

  const result = await tool.execute("1", { action: "send", media: "/tmp/chart.png", text });

  assert.deepEqual(calls.map((call) => call.method), ["rich"]);
  const rich = calls[0]?.payload.rich_message as { markdown: string; media: Array<{ id: string; media: { type: string; media: unknown } }> };
  assert.match(rich.markdown, /^!\[\]\(tg:\/\/photo\?id=m0\)\n\n/);
  assert.equal(rich.markdown.length, text.length + "![](tg://photo?id=m0)\n\n".length);
  assert.equal(rich.media[0]?.media.type, "photo");
  assert.ok(rich.media[0]?.media.media instanceof InputFile);
  assert.match(String(result.content[0]?.text), /message_id 12/);
});

test("several files become one collage", async () => {
  const { calls, tool } = fakeToolApi();

  await tool.execute("1", { action: "send", media: ["/tmp/a.png", "/tmp/b.mp4"], text: "Both" });

  const rich = calls[0]?.payload.rich_message as { markdown: string; media: Array<{ id: string }> };
  assert.match(rich.markdown, /<tg-collage>\n\n!\[\]\(tg:\/\/photo\?id=m0\)\n!\[\]\(tg:\/\/video\?id=m1\)\n\n<\/tg-collage>/);
  assert.deepEqual(rich.media.map((entry) => entry.id), ["m0", "m1"]);
});

test("a chat that refuses embedded media still gets the file, with a caption", async () => {
  const { calls, tool } = fakeToolApi({ rejectRich: true });

  await tool.execute("1", { action: "send", media: "/tmp/chart.png", text: "y".repeat(2_000) });

  assert.deepEqual(calls.map((call) => call.method), ["rich", "photo"]);
  assert.equal(String(calls[1]?.payload.caption).length, 1_024);
});

test("a voice note is never embedded — it has no block of its own", async () => {
  const { calls, tool } = fakeToolApi();

  await tool.execute("1", { action: "send", media: "/tmp/note.ogg", text: "Listen", asVoice: true });

  assert.deepEqual(calls.map((call) => call.method), ["voice"]);
});

test("a pressed keyboard is disabled, ticked, and keeps its links", () => {
  assert.deepEqual(
    disableKeyboard(
      [[{ text: "Yes", callback_data: "yes" }, { text: "No", callback_data: "no" }], [{ text: "Docs", url: "https://x.dev" }]],
      "yes",
    ),
    [
      [{ text: "✓ Yes", disabled: {} }, { text: "No", disabled: {} }],
      [{ text: "Docs", url: "https://x.dev" }],
    ],
  );
});

test("a topic registers and names itself under whoever owns it — a group or a DM", () => {
  const created = { message_thread_id: 7, is_topic_message: true, forum_topic_created: { name: "eleven" } };

  const user: { topics?: Record<string, { title?: string }> } = {};
  assert.equal(registerTopic(user, topicEntry(created)), true);
  assert.deepEqual(user.topics, { "7": { title: "eleven" } });
  // Already known and already named: nothing to persist.
  assert.equal(registerTopic(user, topicEntry(created)), false);

  // A later message in the topic carries no name — the title has to survive it.
  assert.equal(registerTopic(user, topicEntry({ message_thread_id: 7, is_topic_message: true })), false);
  assert.deepEqual(user.topics, { "7": { title: "eleven" } });

  // A rename lands; a plain reply in a non-forum chat is not a topic at all.
  const renamed = { message_thread_id: 7, is_topic_message: true, forum_topic_edited: { name: "eleven v2" } };
  assert.equal(registerTopic(user, topicEntry(renamed)), true);
  assert.equal(user.topics?.["7"].title, "eleven v2");
  assert.equal(topicEntry({ message_thread_id: 9 }), undefined);
  assert.equal(registerTopic(user, undefined), false);
});

test("a replayed command is deduped like any other message", () => {
  let now = 1_000_000;
  const alreadyHandled = createSeenMessages(() => now);

  // Regression: while commands were answered ephemerally they arrived with
  // message_id 0 — no message id to dedupe on, so a replay of one was
  // indistinguishable from a fresh command and ran again. A command is an
  // ordinary message again, so its own id is what identifies it.
  assert.equal(alreadyHandled(-100, 4242), false);
  now += 60_000;
  assert.equal(alreadyHandled(-100, 4243), false);
  assert.equal(alreadyHandled(-100, 4242), true);
  assert.equal(alreadyHandled(-100, 4243), true);
  // A different chat is a different message, same id or not.
  assert.equal(alreadyHandled(-200, 4242), false);

  // The memory lapses with the TTL — Telegram is not expected to redeliver
  // anything that old.
  now += 21 * 60_000;
  assert.equal(alreadyHandled(-100, 4242), false);
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

test("a display name written in lookalike unicode is folded and flagged", () => {
  // An actual pairing request: styled letters spelling out an official-looking name.
  assert.deepEqual(foldDisplayName("T\u{1D68E}\u{1D425}\u{1D68E}g\u{1D69B}\u{1D68A}\u{1D5FA}"), { name: "Telegram", disguised: true });
  // Invisible padding (zero-width space, RTL override) counts as a costume too.
  assert.deepEqual(foldDisplayName("Sup\u200Bport\u202E"), { name: "Support", disguised: true });
  // Ordinary names — including decomposed accents and emoji — pass through unflagged.
  assert.deepEqual(foldDisplayName("  Gabriel   Ceifa "), { name: "Gabriel Ceifa", disguised: false });
  assert.deepEqual(foldDisplayName("Jose\u0301 Silva"), { name: "José Silva", disguised: false });
  assert.deepEqual(foldDisplayName("Samara 🌻"), { name: "Samara 🌻", disguised: false });
});

test("the sender label carries the folded name, not the disguise", () => {
  const ctx = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: { from: { id: 42, first_name: "T\u{1D68E}\u{1D425}\u{1D68E}g\u{1D69B}\u{1D68A}\u{1D5FA}" } },
  };

  assert.equal(formatTelegramInboundPrompt(ctx as never, "hi"), "[Telegram]\nhi");
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

// --- rich message splitting: a chunk boundary must not corrupt what it cuts ---

/** True when a UTF-16 surrogate has lost its other half — the Bot API rejects
 *  the whole message when one appears. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("rich splitting never cuts a surrogate pair in half", () => {
  // One oversized paragraph of astral-plane characters, offset by a single BMP
  // char so the fixed 32000 cut lands *between* the halves of an emoji. Slicing
  // by UTF-16 code units used to hand Telegram a lone surrogate.
  const paragraph = `x${"😀".repeat(20_000)}`;
  const chunks = splitRich(paragraph);

  assert.ok(chunks.length > 1, "the paragraph must actually be split");
  assert.equal(chunks.join(""), paragraph, "splitting must not lose or alter a character");
  for (const chunk of chunks) {
    assert.equal(hasLoneSurrogate(chunk), false, "a chunk must never end or start mid-pair");
    assert.ok(chunk.length <= 32_768, "a chunk must fit the Bot API limit");
  }
});

test("rich splitting prefers a line break over cutting mid-line", () => {
  // A long table: cutting at a fixed offset lands inside a row and leaves both
  // messages with a half-rendered line.
  const row = `| ${"x".repeat(78)} |`;
  const paragraph = Array.from({ length: 500 }, () => row).join("\n");
  const chunks = splitRich(paragraph);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), paragraph);
  for (const chunk of chunks) {
    for (const line of chunk.split("\n").filter(Boolean)) assert.equal(line, row);
  }
});

test("rich splitting closes and reopens a code fence that spans chunks", () => {
  const body = Array.from({ length: 2_000 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const chunks = splitRich(`Here you go:\n\n\`\`\`ts\n${body}\n\`\`\``);

  assert.ok(chunks.length > 2);
  // Every chunk must render on its own: an odd number of fence lines means one
  // message ends inside a code block and the next one starts with orphan code.
  for (const chunk of chunks) {
    const fences = chunk.split("\n").filter((line) => line.startsWith("```")).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk: ${JSON.stringify(chunk.slice(0, 40))}`);
  }
  assert.ok(chunks[1].startsWith("```ts\n"), "the block keeps its opening line");
  assert.ok(chunks[1].endsWith("\n```"), "a chunk ending inside the block closes it");
  assert.ok(chunks[2].startsWith("```ts\n"), "the next chunk reopens it with the same language hint");
});

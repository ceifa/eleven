import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { ChannelType, MessageFlags } from "discord-api-types/v10";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GroupConfig, ModelScope } from "../src/config.ts";

const stateDir = mkdtempSync(join(tmpdir(), "eleven-discord-threads-"));
process.env.ELEVEN_STATE_DIR = stateDir;
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { Gateway } = await import("../src/gateway.ts");
const { startDiscordBot } = await import("../src/channels/discord/bot.ts");
const { DiscordGateway } = await import("../src/channels/discord/gateway.ts");
const { DiscordRest } = await import("../src/channels/discord/rest.ts");
const { discordTool } = await import("../src/channels/discord/tool.ts");
const { PairingStore } = await import("../src/channels/pairing.ts");
const { contentText } = await import("../src/util.ts");

function harness(t: TestContext, parentType = ChannelType.GuildText) {
  const exitListeners = new Set(process.listeners("exit"));
  const group: GroupConfig = {
    title: "Server",
    appendSystemPrompt: "server instructions",
    topics: {
      "10": { title: "Work", appendSystemPrompt: "category instructions", models: [{ model: "claude-code/opus" }] },
      "20": { title: "#work", parent: "10", appendSystemPrompt: "channel instructions" },
    },
  };
  const channel = { type: "discord" as const, name: "home", token: "test", groups: { "1": group } };
  const gateway = new Gateway({
    resolved: { workspaces: { agent: { path: stateDir } }, session: {} },
    turnModels: (_preferred: string | undefined, scopes: (ModelScope | undefined)[]) => scopes.find((scope) => scope?.models)?.models ?? [{ model: "claude-code/sonnet" }],
  } as never);
  const turns: { id: string; request: { text: string; models: { model: string }[]; customTools: ToolDefinition[]; prompt: { appends: string[] } } }[] = [];
  const releases: (() => void)[] = [];
  t.mock.method(gateway.runner, "submit", async (id, request) => {
    turns.push({ id, request });
    await new Promise<void>((resolve) => releases.push(resolve));
    return undefined;
  });
  t.mock.method(DiscordGateway.prototype, "start", () => {});
  const calls: { method: string; path: string; body: any }[] = [];
  let nextId = 30;
  let failSeed = false;
  t.mock.method(DiscordRest.prototype, "request", async (method, path, options = {}) => {
    calls.push({ method, path, body: options.body });
    if (method === "GET" && path === "/channels/20") return { id: "20", type: parentType, guild_id: "1", name: "work", parent_id: "10" };
    if (method === "GET" && path === "/channels/10") return { id: "10", type: ChannelType.GuildCategory, guild_id: "1", name: "Work" };
    if (method === "GET" && path === "/guilds/1/channels") return [{ id: "20", type: parentType, guild_id: "1", name: "inbox", parent_id: "10" }];
    if (method === "GET" && path === "/channels/30") return { id: "30", type: ChannelType.PublicThread, guild_id: "1", name: "Decision", parent_id: "20" };
    if (method === "POST" && path.endsWith("/threads")) return { id: String(nextId++), type: ChannelType.PublicThread, parent_id: "20", name: options.body.name };
    if (failSeed && method === "POST" && path.endsWith("/messages")) throw new Error("seed unavailable");
    return { id: "message" };
  });
  const bot = startDiscordBot("home", "test", {
    gateway,
    pairing: new PairingStore(),
    botConfig: () => channel,
    workspace: () => "agent",
    transcribeCommand: () => undefined,
    autoFailover: () => false,
    updateGroup: (_id, mutate) => { mutate(group); },
    updateUser: () => {},
  });
  const parentTurn = bot.wake("discord:home:1:20");
  t.after(async () => {
    for (const release of releases) release();
    await parentTurn;
    await bot.stop();
    for (const listener of process.listeners("exit")) {
      if (exitListeners.has(listener)) continue;
      listener(0);
      process.removeListener("exit", listener);
    }
  });
  return { bot, gateway, turns, calls, group, failSeed: () => { failSeed = true; } };
}

async function toolOf(turns: ReturnType<typeof harness>["turns"], index = 0) {
  for (let i = 0; i < 50 && !turns[index]; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(turns[index], "turn reached the runner");
  return turns[index]!.request.customTools[0]!;
}

function textOf(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  return contentText(result.content);
}

test("thread action passes a self-contained task without suppressing the parent's reply", async () => {
  const tasks: unknown[] = [];
  const sent: string[] = [];
  const tool = discordTool(new DiscordRest("test"), "20", (text) => sent.push(text), async (task) => {
    tasks.push(task);
    return "created";
  });
  const task = { name: "One", message: "Read this record", start: true };
  assert.equal(textOf(await tool.execute("1", { action: "thread", thread: task })), "created");
  assert.deepEqual(tasks, [task]);
  assert.deepEqual(sent, []);
  assert.match(textOf(await tool.execute("2", { action: "thread" })), /needs a name/);
  assert.match(textOf(await tool.execute("3", { action: "thread", thread: { name: " ", message: "task" } })), /needs a name/);
});

test("three delegated threads start independently, with inherited settings and durable opening context", async (t) => {
  const { gateway, turns, calls, group } = harness(t);
  const tool = await toolOf(turns);
  for (const name of ["First", "Second", "Third"]) {
    const result = textOf(await tool.execute(name, { action: "thread", thread: { name, message: `Resolve ${name}`, start: true } }));
    assert.match(result, /Agent started independently/);
    assert.match(result, /https:\/\/discord.com\/channels\/1\//);
  }
  await toolOf(turns, 3);
  assert.equal(new Set(turns.map((turn) => turn.id)).size, 4, "parent and three children all remain in flight");
  for (const [index, name] of ["First", "Second", "Third"].entries()) {
    const id = String(30 + index);
    const child = gateway.threads.current(`discord:home:1:${id}`)!;
    assert.equal(group.topics![id]!.parent, "20", "registered before resolving settings");
    assert.deepEqual(turns[index + 1]!.request.prompt.appends, ["server instructions", "category instructions", "channel instructions"]);
    assert.deepEqual(turns[index + 1]!.request.models, [{ model: "claude-code/opus" }], "category model beats the workspace default");
    const entries = SessionManager.open(child.sessionFile!).getBranch();
    assert.ok(JSON.stringify(entries).includes(`Resolve ${name}`), "the next user turn can read the opening message");
    assert.ok(!JSON.stringify(entries).includes("Resolve " + (name === "First" ? "Second" : "First")), "siblings do not share context");
  }
  const creates = calls.filter((call) => call.path === "/channels/20/threads");
  assert.equal(creates.length, 3);
  assert.deepEqual(creates[0]!.body, { name: "First", auto_archive_duration: 10080, type: ChannelType.PublicThread });
});

test("start defaults to false and a child can open a sibling instead of an illegal nested thread", async (t) => {
  const { gateway, turns, calls } = harness(t);
  const tool = await toolOf(turns);
  const result = textOf(await tool.execute("1", { action: "thread", thread: { name: "Waiting", message: "Keep this context" } }));
  assert.match(result, /Opening context recorded/);
  assert.equal(turns.length, 1, "no automatic agent turn");
  const child = gateway.threads.current("discord:home:1:30")!;
  assert.ok(child.sessionFile);
  await tool.execute("2", { action: "thread", thread: { name: "Active", message: "Work", start: true } });
  const childTool = await toolOf(turns, 1);
  await childTool.execute("3", { action: "thread", thread: { name: "Sibling", message: "Different work" } });
  assert.equal(calls.filter((call) => call.path === "/channels/20/threads").length, 3);
  assert.equal(calls.filter((call) => call.path === "/channels/31/threads").length, 0);
});

test("a forum sibling supplies its first message atomically and records the whole context", async (t) => {
  const { gateway, turns, calls } = harness(t, ChannelType.GuildForum);
  const tool = await toolOf(turns);
  const message = "context ".repeat(400);
  await tool.execute("1", { action: "thread", thread: { name: "Forum task", message } });
  const create = calls.find((call) => call.path === "/channels/20/threads")!;
  assert.ok(create.body.message.content.length <= 2000);
  assert.deepEqual(create.body.message.allowed_mentions, { parse: [] });
  assert.equal(create.body.message.flags, MessageFlags.SuppressEmbeds);
  assert.ok(calls.some((call) => call.path === "/channels/30/messages"), "remaining chunks arrive after the starter");
  const child = gateway.threads.current("discord:home:1:30")!;
  assert.ok(JSON.stringify(SessionManager.open(child.sessionFile!).getBranch()).includes(message));
});

test("a failed opening message never starts work or claims that nothing was created", async (t) => {
  const { turns, calls, failSeed } = harness(t);
  const tool = await toolOf(turns);
  failSeed();
  const result = textOf(await tool.execute("1", { action: "thread", thread: { name: "Task", message: "Context", start: true } }));
  assert.match(result, /Thread created: https:\/\/discord.com\/channels\/1\/30/);
  assert.match(result, /NOT started/);
  assert.match(result, /Do not create it again/);
  assert.equal(turns.length, 1);
  assert.equal(calls.filter((call) => call.path.endsWith("/threads")).length, 1);
});

test("private threads cannot fan out their context into a public sibling", async (t) => {
  const { turns, calls } = harness(t, ChannelType.PrivateThread);
  const tool = await toolOf(turns);
  const result = textOf(await tool.execute("1", { action: "thread", thread: { name: "Task", message: "Private context", start: true } }));
  assert.match(result, /cannot fan out a private thread/);
  assert.equal(calls.filter((call) => call.path.endsWith("/threads")).length, 0);
});

test("a DM cannot publish its task into a server", async (t) => {
  const { bot, turns, calls } = harness(t);
  await toolOf(turns);
  const dmTurn = bot.wake("discord:home:dm:99");
  const tool = await toolOf(turns, 1);
  const result = textOf(await tool.execute("1", { action: "thread", thread: { name: "Task", message: "DM context", start: true } }));
  assert.match(result, /not a DM/);
  assert.equal(calls.filter((call) => call.path.endsWith("/threads")).length, 0);
  t.after(() => dmTurn);
});

test("a transcript warning keeps the created URL and prevents delegation", async (t) => {
  const { gateway, turns } = harness(t);
  const tool = await toolOf(turns);
  t.mock.method(gateway, "deliverOutbound", async (_id, _text, deliver) => {
    await deliver();
    return { target: undefined, recorded: false, warning: "disk unavailable" };
  });
  const result = textOf(await tool.execute("1", { action: "thread", thread: { name: "Task", message: "Context", start: true } }));
  assert.match(result, /Thread created: https:\/\/discord.com\/channels\/1\/30/);
  assert.match(result, /NOT started: disk unavailable/);
  assert.equal(turns.length, 1);
});

test("control API opens a persistent forum conversation and resumes that exact context", async (t) => {
  const { bot, gateway, turns } = harness(t, ChannelType.GuildForum);
  await toolOf(turns);
  const created = await bot.openThread("discord:home:1:20", "Persistent item", "Opening context", true);
  assert.equal(created.sessionKey, "discord:home:1:30");
  assert.equal(created.recorded, true);
  assert.equal(gateway.threads.get(created.threadId!)?.persistent, true);
  await bot.prompt(created.sessionKey, "Prepare the next decision");
  await toolOf(turns, 1);
  assert.equal(turns[1]!.id, created.threadId);
  assert.equal(turns[1]!.request.text, "Prepare the next decision");
});

test("a remote key cannot spoof a channel from a different server", async (t) => {
  const { bot, turns, calls } = harness(t);
  await toolOf(turns);
  await assert.rejects(bot.openThread("discord:home:2:20", "Task", "Context"), /server is not allowed/);
  assert.equal(calls.filter((call) => call.path.endsWith("/threads")).length, 0);
});

test("archive releases persistent retention only after the active turn settles", async (t) => {
  const { bot, gateway, turns, calls } = harness(t, ChannelType.GuildForum);
  await toolOf(turns);
  const created = await bot.openThread("discord:home:1:20", "Persistent item", "Opening context", true);
  let running = true;
  t.mock.method(gateway, "isThreadRunning", () => running);
  let finish!: () => void;
  t.mock.method(gateway.runner, "submit", async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return undefined;
  });
  await bot.prompt(created.sessionKey, "Resolve this item");
  await bot.archive(created.sessionKey);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  assert.equal(gateway.threads.get(created.threadId!)?.persistent, true);
  running = false;
  finish();
  for (let i = 0; i < 50 && !calls.some((call) => call.method === "PATCH"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, { archived: true });
  assert.equal(gateway.threads.get(created.threadId!)?.persistent, false);
});

test("an unsuccessful archive retains its durable request and protected context for retry", async (t) => {
  const { bot, gateway, turns } = harness(t, ChannelType.GuildForum);
  await toolOf(turns);
  const created = await bot.openThread("discord:home:1:20", "Persistent item", "Opening context", true);
  const request = t.mock.method(DiscordRest.prototype, "request", async () => { throw new Error("unavailable"); });
  await assert.rejects(bot.archive(created.sessionKey), /unavailable/);
  assert.equal(gateway.threads.get(created.threadId!)?.archiveRequested, true);
  assert.equal(gateway.threads.get(created.threadId!)?.persistent, true);
  request.mock.restore();
  await bot.archive(created.sessionKey);
  assert.equal(gateway.threads.get(created.threadId!)?.archiveRequested, false);
});


test("destination discovery exposes the hierarchy without exposing platform credentials", async (t) => {
  const { bot, turns } = harness(t, ChannelType.GuildForum);
  await toolOf(turns);
  assert.deepEqual(await bot.destinations(), [{ sessionKey: "discord:home:1:20", title: "inbox", kind: "forum", parent: "discord:home:1:10", groupTitle: "Server" }]);
  assert.deepEqual(await bot.describe("discord:home:1:30"), { sessionKey: "discord:home:1:30", title: "Decision", kind: "thread", parent: "discord:home:1:20", groupTitle: "Server" });
  await assert.rejects(bot.describe("discord:home:2:30"), /server is not allowed/);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ButtonStyle, ComponentType, GatewayOpcodes } from "discord-api-types/v10";
import { Bursts } from "../src/channels/burst.ts";
import { Channels, type Channel } from "../src/channels/index.ts";
import { formatDiscordInboundPrompt } from "../src/channels/discord/bot.ts";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { discordChunks, toDiscordMarkdown } from "../src/channels/discord/markdown.ts";
import { DiscordApiError, DiscordRest } from "../src/channels/discord/rest.ts";
import { components, disableComponents } from "../src/channels/discord/send.ts";
import { discordSessionKey, parseDiscordSessionKey } from "../src/channels/discord/session-key.ts";
import { conversationModelScopes, parseSessionKey } from "../src/channels/session-key.ts";
import { conversationIdentity } from "../src/threads/conversation.ts";
import { logger } from "../src/log.ts";

const log = logger("test");

test("a Discord DM is keyed by the person, a server conversation by server and channel", () => {
  const dm = discordSessionKey("home", { userId: "1180000000000000001" });
  const room = discordSessionKey("home", { guildId: "1170000000000000001", channelId: "1170000000000000002" });
  assert.equal(dm, "discord:home:dm:1180000000000000001");
  assert.equal(room, "discord:home:1170000000000000001:1170000000000000002");
  assert.deepEqual(parseDiscordSessionKey(dm), { channel: "home", userId: "1180000000000000001" });
  assert.deepEqual(parseDiscordSessionKey(room), { channel: "home", guildId: "1170000000000000001", channelId: "1170000000000000002" });
  assert.equal(parseDiscordSessionKey("telegram:main:42"), undefined);
  // Both platforms reduce to the same registry shape: an owner, maybe a topic.
  assert.deepEqual(parseSessionKey(room), { type: "discord", channel: "home", owner: { kind: "group", id: "1170000000000000001" }, topic: "1170000000000000002" });
  assert.deepEqual(parseSessionKey(dm), { type: "discord", channel: "home", owner: { kind: "user", id: "1180000000000000001" }, topic: undefined });
  assert.deepEqual(parseSessionKey("telegram:main:-100:topic:7"), { type: "telegram", channel: "main", owner: { kind: "group", id: "-100" }, topic: "7" });
});

test("a Discord conversation is named by its channel, then its server, then the person", () => {
  const channels = [{
    type: "discord" as const,
    name: "home",
    token: "t",
    users: { "11": { name: "Gabriel", username: "ceifa" } },
    groups: { "22": { title: "Sesh", topics: { "33": { title: "eleven", models: [{ model: "claude-code/sonnet" }] } } } },
  }];
  assert.deepEqual(conversationIdentity("discord:home:22:33", channels), { name: "#eleven", context: "Sesh", label: "Discord · Sesh · #eleven" });
  assert.deepEqual(conversationIdentity("discord:home:dm:11", channels), {
    name: "Gabriel",
    context: "Discord DM",
    label: "Discord DM · Gabriel",
    picture: { kind: "photo", version: "1" },
  });
  // Nothing invented before the registry learns a name.
  assert.equal(conversationIdentity("discord:home:22:44", channels).name, "channel 44");
  assert.equal(conversationIdentity("discord:home:99:44", channels).context, "99");
  // A channel's model settings outrank its server's.
  assert.deepEqual(conversationModelScopes("discord:home:22:33", channels)[0], { title: "eleven", models: [{ model: "claude-code/sonnet" }] });
});

test("a table becomes a monospace block with its columns lined up", () => {
  const markdown = [
    "Prices:",
    "",
    "| Plan | **Cost** |",
    "|------|---:|",
    "| Pro | $20 |",
    "| Max \\| team | $200 |",
    "",
    "Done.",
  ].join("\n");
  assert.equal(toDiscordMarkdown(markdown), [
    "Prices:",
    "",
    "```",
    "Plan        Cost",
    "──────────  ────",
    "Pro         $20",
    "Max | team  $200",
    "```",
    "",
    "Done.",
  ].join("\n"));
});

test("Discord markdown leaves code alone and flattens headings it cannot draw", () => {
  const code = "```\n| a | b |\n|---|---|\n#### not a heading\n```";
  assert.equal(toDiscordMarkdown(code), code);
  assert.equal(toDiscordMarkdown("### kept\n#### Deep"), "### kept\n**Deep**");
});

test("a long answer splits under Discord's 2000 characters, code fences balanced", () => {
  const code = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = discordChunks(`intro\n\n\`\`\`ts\n${code}\n\`\`\``);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000, `chunk of ${chunk.length}`);
    assert.equal((chunk.match(/```/g) ?? []).length % 2, 0, "every chunk closes the fences it opens");
  }
  assert.deepEqual(discordChunks("   "), []);
});

test("buttons become action rows within Discord's limits, and a press greys them out", () => {
  const rows = components([
    [{ label: "Yes", data: "yes" }, { label: "Docs", url: "https://example.com" }],
    [],
    [{ label: "x".repeat(90), data: "y".repeat(150) }],
  ])!;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.components[1], { type: ComponentType.Button, style: ButtonStyle.Link, label: "Docs", url: "https://example.com" });
  const long = rows[1]!.components[0] as { label: string; custom_id: string };
  assert.equal(long.label.length, 80);
  assert.equal(long.custom_id.length, 100);

  const [row] = disableComponents(rows, "yes") as typeof rows;
  assert.deepEqual(row!.components[0], { type: ComponentType.Button, style: ButtonStyle.Primary, label: "✓ Yes", custom_id: "yes", disabled: true });
  // A link is not an action: it stays usable after the fact.
  assert.equal((row!.components[1] as { disabled?: boolean }).disabled, undefined);
});

test("server messages carry who said them and what they answer; DMs stay bare", () => {
  const author = { id: "1", username: "ceifa", global_name: "Gabriel", discriminator: "0", avatar: null };
  const bot = { id: "9", username: "eleven", global_name: null, discriminator: "0", avatar: null };
  assert.equal(formatDiscordInboundPrompt({ author, referenced_message: undefined }, "hi", "9"), "hi");
  const reply = formatDiscordInboundPrompt(
    { author, guild_id: "5", referenced_message: { author: bot, content: "the build is green" } as never },
    "ship it",
    "9",
  );
  assert.equal(reply, '[Gabriel @ceifa]\n[Replying to you: "the build is green"]\nship it');
});

/** A socket the gateway can drive and the test can speak through. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: { op: number; d: unknown }[] = [];
  closedWith: number | undefined;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  receive(payload: object) {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function gatewayHarness() {
  const sockets: FakeSocket[] = [];
  const gateway = new DiscordGateway("token", 513, log, (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as never;
  });
  const ready = () =>
    sockets.at(-1)!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "sess", resume_gateway_url: "wss://resume.discord.gg", user: { id: "9", username: "eleven" }, application: { id: "app" } } });
  return { gateway, sockets, ready };
}

test("the gateway identifies, then resumes the same session after a drop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, sockets, ready } = gatewayHarness();
  gateway.start();
  sockets[0]!.receive({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 40_000 } });
  assert.equal(sockets[0]!.sent[0]!.op, GatewayOpcodes.Identify);
  assert.equal((sockets[0]!.sent[0]!.d as { intents: number }).intents, 513);
  ready();
  assert.equal(gateway.ready, true);

  sockets[0]!.emit("close", 1006, Buffer.from(""));
  assert.equal(gateway.ready, false);
  t.mock.timers.tick(2_000);
  assert.equal(sockets.length, 2);
  assert.match(sockets[1]!.url, /^wss:\/\/resume\.discord\.gg/);
  sockets[1]!.receive({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 40_000 } });
  // Resuming replays what was missed: the drop costs no messages.
  assert.deepEqual(sockets[1]!.sent[0], { op: GatewayOpcodes.Resume, d: { token: "token", session_id: "sess", seq: 1 } });
  gateway.stop();
});

test("a heartbeat nobody acknowledges is a dead connection, replaced without losing the session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, sockets, ready } = gatewayHarness();
  gateway.start();
  sockets[0]!.receive({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 1_000 } });
  ready();
  t.mock.timers.tick(1_000);
  assert.ok(sockets[0]!.sent.some((payload) => payload.op === GatewayOpcodes.Heartbeat));
  t.mock.timers.tick(1_000); // no ack arrived
  // A close Discord reads as resumable — 1000 would end the session.
  assert.equal(sockets[0]!.closedWith, 4000);
  t.mock.timers.tick(2_000);
  sockets[1]!.receive({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 1_000 } });
  assert.equal(sockets[1]!.sent[0]!.op, GatewayOpcodes.Resume);
  gateway.stop();
});

test("a session Discord invalidates for good is started over, and a refused intent stops the bot", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, sockets, ready } = gatewayHarness();
  const fatal: number[] = [];
  gateway.on("fatal", (code) => fatal.push(code));
  gateway.start();
  sockets[0]!.receive({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 40_000 } });
  ready();
  sockets[0]!.receive({ op: GatewayOpcodes.InvalidSession, d: false });
  t.mock.timers.tick(6_000);
  sockets[1]!.receive({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 40_000 } });
  assert.equal(sockets[1]!.sent[0]!.op, GatewayOpcodes.Identify);

  sockets[1]!.emit("close", 4014, Buffer.from("Disallowed intent(s)."));
  t.mock.timers.tick(120_000);
  assert.deepEqual(fatal, [4014]);
  assert.equal(sockets.length, 2, "no retry can grant an intent");
  gateway.stop();
});

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a rate-limited request waits out retry_after and goes again", async () => {
  const { calls, impl } = fakeFetch([json(429, { retry_after: 0.01, global: false }), json(200, { id: "m1" })]);
  const rest = new DiscordRest("token", impl);
  const message = await rest.request<{ id: string }>("POST", "/channels/1/messages", { body: { content: "hi" }, creates: true });
  assert.equal(message.id, "m1");
  assert.equal(calls.length, 2);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bot token");
});

test("a message send that may have landed is never repeated; an edit is", async () => {
  const send = fakeFetch([json(502, { message: "Bad Gateway" }), json(200, {})]);
  await assert.rejects(
    () => new DiscordRest("token", send.impl).request("POST", "/channels/1/messages", { body: { content: "hi" }, creates: true }),
    (error: unknown) => error instanceof DiscordApiError && error.status === 502,
  );
  assert.equal(send.calls.length, 1, "a duplicate is worse than a gap");

  const edit = fakeFetch([json(502, {}), json(200, { id: "m1" })]);
  await new DiscordRest("token", edit.impl).request("PATCH", "/channels/1/messages/m1", { body: { content: "hi" } });
  assert.equal(edit.calls.length, 2);
});

test("files ride as multipart, announced in the payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-discord-"));
  try {
    const path = join(dir, "report.txt");
    writeFileSync(path, "all good");
    const { calls, impl } = fakeFetch([json(200, { id: "m1" })]);
    await new DiscordRest("token", impl).request("POST", "/channels/1/messages", { body: { content: "here" }, files: [{ path }], creates: true });
    const form = calls[0]!.init.body as FormData;
    assert.deepEqual(JSON.parse(form.get("payload_json") as string), { content: "here", attachments: [{ id: 0, filename: "report.txt" }] });
    assert.equal(await (form.get("files[0]") as Blob).text(), "all good");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a burst becomes one turn, and waits for a sibling still being prepared", async () => {
  const turns: { target: { triggerMessageId?: string }; text: string }[] = [];
  const bursts = new Bursts<{ triggerMessageId?: string }>((target, text) => turns.push({ target, text }), 20, 200);
  const release = bursts.prepare("k");
  bursts.enqueue("k", { triggerMessageId: "1" }, "first", []);
  bursts.enqueue("k", {}, "second", []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(turns.length, 0, "a voice note still transcribing holds the burst");
  release();
  assert.deepEqual(turns, [{ target: { triggerMessageId: "1" }, text: "first\n\nsecond" }]);
  bursts.enqueue("k", {}, "later", []);
  assert.equal(bursts.discard("k"), true);
  assert.equal(bursts.discard("k"), false);
});

test("one router: calls about a conversation reach the channel its key names, and pairing writes to the right registry", async () => {
  const saved: unknown[] = [];
  const raw = {
    dashboard: { port: 1111, host: "127.0.0.1" },
    models: [],
    workspaces: { agent: { path: "/tmp", channels: [{ type: "discord", name: "home", token: "t" }, { type: "telegram", name: "main", token: "u" }] } },
  };
  const config = {
    raw,
    channels: (from = raw) => Object.values(from.workspaces).flatMap((w) => w.channels.map((channel) => ({ workspace: "agent", channel }))),
    save: (next: unknown) => saved.push(next),
  };
  const calls: string[] = [];
  const fake = (type: "telegram" | "discord"): Channel => ({
    type,
    status: () => [{ type, name: type, connected: true }],
    sendToSession: async (key) => (calls.push(`${type} send ${key}`), { channel: type, bot: type, chatId: 1 }),
    discardPending: (key) => (calls.push(`${type} discard ${key}`), true),
    wakeInterrupted: (turns) => calls.push(`${type} wake ${turns.map((t) => t.sessionKey).join(",")}`),
    avatar: async () => undefined,
    welcome: async (request) => void calls.push(`${type} welcome ${request.chatId}`),
    stop: async () => {},
  });
  const requests = [
    { id: "r1", kind: "group" as const, bot: "home", userId: "1180000000000000001", chatId: "1170000000000000001", chatTitle: "Sesh", origin: "1170000000000000002", createdAt: 0 },
  ];
  const pairing = { take: (id: string) => requests.find((r) => r.id === id) };
  const channels = new Channels(config as never, pairing as never, [fake("telegram"), fake("discord")]);

  assert.equal(channels.discardPending("discord:home:dm:5"), true);
  assert.equal(channels.discardPending("dashboard:agent:x"), false);
  channels.wakeInterrupted([{ sessionKey: "telegram:main:1" }, { sessionKey: "discord:home:dm:5" }]);
  await channels.sendToSession("discord:home:2:3", "hi");
  await assert.rejects(() => channels.sendToSession("cli:agent:x", "hi"), /no channel/);

  await channels.approvePairing("r1");
  const written = saved[0] as typeof raw & { workspaces: { agent: { channels: { groups?: Record<string, unknown> }[] } } };
  // The id stays a string: a snowflake does not survive a trip through a double.
  assert.deepEqual(written.workspaces.agent.channels[0]!.groups, { "1170000000000000001": { requireMention: false, title: "Sesh" } });
  assert.deepEqual(calls, [
    "discord discard discord:home:dm:5",
    "telegram wake telegram:main:1",
    "discord wake discord:home:dm:5",
    "discord send discord:home:2:3",
    "discord welcome 1170000000000000001",
  ]);
});

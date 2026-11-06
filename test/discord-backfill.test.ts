import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { APIMessage } from "discord-api-types/v10";

const stateDir = mkdtempSync(join(tmpdir(), "eleven-backfill-"));
process.env.ELEVEN_STATE_DIR = stateDir;
const { startDiscordBot } = await import("../src/channels/discord/bot.ts");
const { discordSessionKey } = await import("../src/channels/discord/session-key.ts");
const { BACKFILL_MAX_PER_CHANNEL, missedMessages, snowflakeAt, Watermark } = await import("../src/channels/discord/backfill.ts");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

const message = (id: string, extra: Partial<APIMessage> = {}) =>
  ({ id, channel_id: "C", content: "oi", mentions: [], mention_roles: [], attachments: [], author: { id: "U", username: "ceifa", global_name: null, discriminator: "0", avatar: null }, ...extra }) as unknown as APIMessage;

test("a snowflake minted at a moment sorts after the mark for that moment", () => {
  // Discord's documented example: 175928847299117063 was created at 1462015105796.
  assert.equal(BigInt(snowflakeAt(1462015105796)) >> 22n, 175928847299117063n >> 22n);
  assert.ok(BigInt(snowflakeAt(1462015105796)) <= 175928847299117063n);
});

test("missed messages come back oldest first, minus the ones the bot already acknowledged", async () => {
  let asked = "";
  const page = [message("30"), message("10"), message("20", { reactions: [{ me: true, count: 1 } as never] })];
  const missed = await missedMessages(async <T>(path: string) => {
    asked = path;
    return page as T;
  }, "C", "5");
  assert.equal(asked, `/channels/C/messages?after=5&limit=${BACKFILL_MAX_PER_CHANNEL + 1}`);
  assert.deepEqual(missed?.map((m) => m.id), ["10", "30"]);
});

test("a channel that moved on without the bot is not replayed message by message", async () => {
  const flood = Array.from({ length: BACKFILL_MAX_PER_CHANNEL + 1 }, (_, i) => message(String(i + 10)));
  assert.equal(await missedMessages(async <T>() => flood as T, "C", "5"), undefined);
});

test("the watermark survives a restart, and a broken file means none", () => {
  const file = join(stateDir, "wm", "home.json");
  assert.equal(new Watermark(file).value, undefined);
  new Watermark(file).save(1234);
  assert.equal(new Watermark(file).value, 1234);
  writeFileSync(file, "{");
  assert.equal(new Watermark(file).value, undefined);
});

test("a message sent while the daemon was down is answered after a fresh session starts", async () => {
  // Regression: on 2026-11-04 a message sent during a reboot never became a
  // turn. A new session (READY) replays nothing, unlike a resumed one.
  mkdirSync(join(stateDir, "discord"), { recursive: true });
  writeFileSync(join(stateDir, "discord", "home.json"), JSON.stringify({ at: Date.now() - 10 * 60_000 }));
  const missedId = (BigInt(snowflakeAt(Date.now() - 5 * 60_000)) + 1n).toString();

  const acked: string[] = [];
  const rest = {
    get: async (path: string) => (path.startsWith("/channels/C/messages?after=") ? [message(missedId)] : {}),
    request: async (method: string, path: string) => {
      if (method === "PUT" && path.includes("/reactions/")) acked.push(path);
      if (path === "/users/@me/channels") return { id: "DM", type: 1, last_message_id: null };
      return {};
    },
  };
  const gateway = Object.assign(new EventEmitter(), { ready: true, lastAckAt: Date.now(), start() {}, stop() {} });
  const config = { type: "discord" as const, name: "home", token: "t", users: { U: {} }, groups: { G: { requireMention: false } } };
  const bot = startDiscordBot("home", "t", {
    gateway: { threads: { list: () => [] } },
    pairing: {},
    botConfig: () => config,
    workspace: () => undefined,
    transcribeCommand: () => undefined,
    autoFailover: () => false,
    updateGroup: () => {},
    updateUser: () => {},
  } as never, { rest, gateway } as never);

  gateway.emit("ready", { user: { id: "BOT", username: "mortar" }, application: { id: "APP" }, guilds: [{ id: "G", unavailable: true }] });
  gateway.emit("dispatch", { t: "GUILD_CREATE", d: { id: "G", name: "home", icon: null, roles: [], channels: [{ id: "C", type: 0, name: "general", last_message_id: missedId }], threads: [] } });
  for (let i = 0; i < 50 && !acked.length; i++) await delay(10);

  assert.deepEqual(acked, [`/channels/C/messages/${missedId}/reactions/${encodeURIComponent("👀")}/@me`]);
  bot.discardBurst(discordSessionKey("home", { guildId: "G", channelId: "C" }));
  await bot.stop();
});

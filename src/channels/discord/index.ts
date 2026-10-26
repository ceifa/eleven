import type { ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import { AVATARS_DIR } from "../../paths.ts";
import { AvatarCache, type Avatar } from "../avatars.ts";
import { BotPool } from "../bots.ts";
import type { Channel, ChannelStatus, DeliveryTarget } from "../index.ts";
import type { PairingRequest, PairingStore } from "../pairing.ts";
import { startDiscordBot, type BotHandle } from "./bot.ts";
import { parseDiscordSessionKey } from "./session-key.ts";

// People and servers change their pictures now and then; a day behind is fine
// for a face in a list.
const PICTURE_TTL_MS = 24 * 60 * 60 * 1000;

/** Discord, one gateway connection per channel configured across workspaces. */
export class DiscordChannel implements Channel {
  readonly type = "discord";
  private avatars: AvatarCache;
  private pool: BotPool<BotHandle>;

  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore, avatarsDir = AVATARS_DIR) {
    this.avatars = new AvatarCache(avatarsDir);
    this.pool = new BotPool("discord", config, { gateway, pairing }, startDiscordBot);
  }

  private owner(sessionKey: string): BotHandle | undefined {
    const target = parseDiscordSessionKey(sessionKey);
    return target && this.pool.get(target.channel);
  }

  async welcome(request: PairingRequest): Promise<void> {
    await this.pool.get(request.bot)?.welcome(request);
  }

  async sendToSession(sessionKey: string, text: string): Promise<DeliveryTarget> {
    const target = parseDiscordSessionKey(sessionKey);
    if (!target) throw new Error("thread has no Discord delivery target");
    const handle = this.pool.get(target.channel);
    if (!handle) throw new Error(`Discord channel ${target.channel} is not running`);
    await handle.send(sessionKey, text);
    return { channel: "discord", bot: target.channel, chatId: target.guildId ?? target.userId!, topic: target.channelId };
  }

  discardPending(sessionKey: string): boolean {
    return this.owner(sessionKey)?.discardBurst(sessionKey) ?? false;
  }

  wakeInterrupted(turns: { sessionKey: string }[]): void {
    for (const { sessionKey } of turns) void this.owner(sessionKey)?.wake(sessionKey);
  }

  /** A DM's face is the person's avatar. Every server conversation is a
   *  channel, and a channel has no picture of its own. Only for people this
   *  channel knows: a session key off the street does not get to make the bot
   *  look up arbitrary users. */
  async avatar(sessionKey: string): Promise<Avatar | undefined> {
    const target = parseDiscordSessionKey(sessionKey);
    const userId = target?.userId;
    if (!target || !userId || !this.pool.find(target.channel)?.channel.users?.[userId]) return undefined;
    const handle = this.pool.get(target.channel);
    return this.avatars.get(`discord-${target.channel}-user-${userId}`, PICTURE_TTL_MS, () =>
      handle ? handle.picture("user", userId) : Promise.reject(new Error(`channel ${target.channel} is not running`)),
    );
  }

  status(): ChannelStatus[] {
    return [...this.pool.bots.entries()].map(([name, { handle }]) => ({
      type: "discord" as const,
      name,
      username: handle.username,
      connected: handle.connected(),
    }));
  }

  stop() {
    return this.pool.stop();
  }
}

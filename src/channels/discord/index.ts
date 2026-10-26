import { isUnresolved, type ChannelConfig, type ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import { AVATARS_DIR } from "../../paths.ts";
import { logger } from "../../log.ts";
import { AvatarCache, type Avatar } from "../avatars.ts";
import type { Channel, ChannelStatus, DeliveryTarget } from "../index.ts";
import type { PairingRequest, PairingStore } from "../pairing.ts";
import { startDiscordBot, type BotHandle } from "./bot.ts";
import { parseDiscordSessionKey } from "./session-key.ts";

const log = logger("discord");
// People and servers change their pictures now and then; a day behind is fine
// for a face in a list.
const PICTURE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs one gateway connection per discord channel configured across
 * workspaces and keeps them in sync with config changes (dashboard edits): new
 * channels start, removed/re-tokened ones restart. Allowlist and workspace
 * edits apply live via the config getter.
 */
export class DiscordChannel implements Channel {
  readonly type = "discord";
  private bots = new Map<string, { handle: BotHandle; token: string }>();
  private avatars: AvatarCache;
  private config: ConfigStore;
  private gateway: Gateway;
  private pairing: PairingStore;

  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore, avatarsDir = AVATARS_DIR) {
    this.config = config;
    this.gateway = gateway;
    this.pairing = pairing;
    this.avatars = new AvatarCache(avatarsDir);
    config.on("change", () => this.sync());
    this.sync();
  }

  private find(name: string): { workspace: string; channel: ChannelConfig } | undefined {
    return this.config.channels().find((c) => c.channel.type === "discord" && c.channel.name === name);
  }

  private sync() {
    const wanted = new Map(
      this.config
        .channels()
        .filter((c) => c.channel.type === "discord")
        .map((c) => [c.channel.name, c.channel]),
    );

    for (const [name, entry] of this.bots) {
      const next = wanted.get(name);
      if (!next || next.token !== entry.token) {
        log.info(`stopping bot ${name}`);
        void entry.handle.stop();
        this.bots.delete(name);
      }
    }

    for (const [name, channel] of wanted) {
      if (this.bots.has(name)) continue;
      if (isUnresolved(channel.token)) {
        log.warn(`channel ${name} has an unresolved token, skipping`);
        continue;
      }
      if ([...this.bots.values()].some((b) => b.token === channel.token)) {
        log.error(`channel ${name} reuses another channel's token — skipping (each connection would answer every message twice)`);
        continue;
      }
      log.info(`starting bot ${name}`);
      const handle = startDiscordBot(name, channel.token, {
        gateway: this.gateway,
        pairing: this.pairing,
        botConfig: () => this.find(name)?.channel,
        workspace: () => this.find(name)?.workspace,
        transcribeCommand: () => this.config.resolved.transcription?.command,
        autoFailover: () => this.config.resolved.autoFailover === true,
        updateGroup: (guildId, mutate) => this.updateEntry(name, (c) => c.groups?.[guildId], mutate),
        updateUser: (userId, mutate) => this.updateEntry(name, (c) => c.users?.[userId], mutate),
      });
      this.bots.set(name, { handle, token: channel.token });
    }
  }

  /** Registry maintenance from live traffic (server and channel names, user
   * names) — mutates one entry inside the raw config and saves only when
   * `mutate` reports a change. */
  private updateEntry<T>(channelName: string, pick: (channel: ChannelConfig) => T | undefined, mutate: (entry: T) => boolean) {
    const channel = this.config.channels(this.config.raw).find((c) => c.channel.name === channelName)?.channel;
    const entry = channel && pick(channel);
    if (!entry || !mutate(entry)) return;
    this.config.save(this.config.raw);
  }

  private owner(sessionKey: string): BotHandle | undefined {
    const target = parseDiscordSessionKey(sessionKey);
    return target && this.bots.get(target.channel)?.handle;
  }

  async welcome(request: PairingRequest): Promise<void> {
    await this.bots.get(request.bot)?.handle.welcome(request);
  }

  async sendToSession(sessionKey: string, text: string): Promise<DeliveryTarget> {
    const target = parseDiscordSessionKey(sessionKey);
    if (!target) throw new Error("thread has no Discord delivery target");
    const handle = this.bots.get(target.channel)?.handle;
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
    if (!target || !userId || !this.find(target.channel)?.channel.users?.[userId]) return undefined;
    const handle = this.bots.get(target.channel)?.handle;
    return this.avatars.get(`discord-${target.channel}-user-${userId}`, PICTURE_TTL_MS, () =>
      handle ? handle.picture("user", userId) : Promise.reject(new Error(`channel ${target.channel} is not running`)),
    );
  }

  status(): ChannelStatus[] {
    return [...this.bots.entries()].map(([name, { handle }]) => ({
      type: "discord" as const,
      name,
      username: handle.username,
      connected: handle.connected(),
    }));
  }

  async stop() {
    await Promise.all([...this.bots.values()].map((b) => b.handle.stop()));
    this.bots.clear();
  }
}

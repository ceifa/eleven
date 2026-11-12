import { canRetrySend } from "./rest.ts";
import type { ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import { AVATARS_DIR } from "../../paths.ts";
import { AvatarCache, type Avatar } from "../avatars.ts";
import { BotChannel } from "../bots.ts";
import type { PairingStore } from "../pairing.ts";
import { startDiscordBot, type BotHandle } from "./bot.ts";
import { parseDiscordSessionKey } from "./session-key.ts";

// People and servers change their pictures now and then; a day behind is fine
// for a face in a list.
const PICTURE_TTL_MS = 24 * 60 * 60 * 1000;

/** Discord, one gateway connection per channel configured across workspaces. */
export class DiscordChannel extends BotChannel<BotHandle> {
  private avatars: AvatarCache;

  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore, avatarsDir = AVATARS_DIR) {
    super("discord", "Discord", config, { gateway, pairing }, startDiscordBot, canRetrySend);
    this.avatars = new AvatarCache(avatarsDir);
  }

  /** A DM's face is the person's avatar. Every server conversation is a
   *  channel, and a channel has no picture of its own. Only for people this
   *  channel knows: a session key off the street does not get to make the bot
   *  look up arbitrary users. */
  override async avatar(sessionKey: string): Promise<Avatar | undefined> {
    const target = parseDiscordSessionKey(sessionKey);
    const userId = target?.userId;
    if (!target || !userId || !this.pool.find(target.channel)?.channel.users?.[userId]) return undefined;
    const handle = this.pool.get(target.channel);
    return this.avatars.get(`discord-${target.channel}-user-${userId}`, PICTURE_TTL_MS, () =>
      handle ? handle.picture("user", userId) : Promise.reject(new Error(`channel ${target.channel} is not running`)),
    );
  }
}

import { canRetrySend } from "./retry.ts";
import type { ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import type { PairingStore } from "../pairing.ts";
import { AvatarCache, type Avatar } from "../avatars.ts";
import { BotChannel } from "../bots.ts";
import type { DeliveryTarget } from "../index.ts";
import type { ConversationTarget } from "../session-key.ts";
import { startTelegramBot, type BotHandle } from "./bot.ts";
import { parseTelegramSessionKey } from "./session-key.ts";
import { chatPhoto, topicEmoji } from "./avatars.ts";
import { AVATARS_DIR } from "../../paths.ts";
// People and groups change their pictures now and then; a day behind is fine
// for a face in a list. A custom emoji's id names one image forever.
const CHAT_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

/** Telegram, one polling bot per channel configured across workspaces. */
export class TelegramChannel extends BotChannel<BotHandle> {
  private avatars: AvatarCache;

  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore, avatarsDir = AVATARS_DIR) {
    super("telegram", "Telegram", config, { gateway, pairing }, startTelegramBot, canRetrySend);
    this.avatars = new AvatarCache(avatarsDir);
  }

  /** Telegram's ids are numbers, and a delivery reports them as such. */
  protected override deliveryTarget(target: ConversationTarget): DeliveryTarget {
    return { ...super.deliveryTarget(target), chatId: Number(target.owner.id), topic: target.topic === undefined ? undefined : Number(target.topic) };
  }

  /** The picture Telegram draws for a conversation: a forum topic's custom
   *  emoji, or the chat's photo — the group's, or the person's in a DM. Only
   *  for conversations this channel knows: a session key off the street does
   *  not get to make the bot look up arbitrary chats. A topic without an emoji
   *  has no picture; Telegram draws it as a coloured bubble, and so does the
   *  dashboard. With its bot down, whatever was cached is still served. */
  override async avatar(sessionKey: string): Promise<Avatar | undefined> {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target) return undefined;
    const channel = this.pool.find(target.channel)?.channel;
    const chatKey = String(target.chatId);
    const owner = target.chatId > 0 ? channel?.users?.[chatKey] : channel?.groups?.[chatKey];
    if (!channel || !owner) return undefined;
    const api = this.pool.get(target.channel)?.bot.api;
    const token = channel.token;
    const offline = () => Promise.reject(new Error(`channel ${target.channel} is not running`));
    if (target.topic !== undefined) {
      const emojiId = owner.topics?.[String(target.topic)]?.iconEmojiId;
      if (!emojiId) return undefined;
      return this.avatars.get(`emoji-${emojiId}`, Infinity, () => (api ? topicEmoji(api, token, emojiId) : offline()));
    }
    return this.avatars.get(`chat-${target.channel}-${chatKey}`, CHAT_PHOTO_TTL_MS, () =>
      api ? chatPhoto(api, token, target.chatId) : offline(),
    );
  }
}

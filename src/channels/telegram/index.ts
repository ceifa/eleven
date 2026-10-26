import type { ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import type { PairingRequest, PairingStore } from "../pairing.ts";
import { AvatarCache, type Avatar } from "../avatars.ts";
import { BotPool } from "../bots.ts";
import type { Channel, ChannelStatus, DeliveryTarget } from "../index.ts";
import { startTelegramBot, type BotHandle } from "./bot.ts";
import { parseTelegramSessionKey } from "./session-key.ts";
import { sendRich } from "./rich.ts";
import { chatPhoto, topicEmoji } from "./avatars.ts";
import { AVATARS_DIR } from "../../paths.ts";
// People and groups change their pictures now and then; a day behind is fine
// for a face in a list. A custom emoji's id names one image forever.
const CHAT_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

/** Telegram, one polling bot per channel configured across workspaces. */
export class TelegramChannel implements Channel {
  readonly type = "telegram";
  private avatars: AvatarCache;
  private pool: BotPool<BotHandle>;

  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore, avatarsDir = AVATARS_DIR) {
    this.avatars = new AvatarCache(avatarsDir);
    this.pool = new BotPool("telegram", config, { gateway, pairing }, startTelegramBot);
  }

  /** Tell an approved requester they're in. */
  async welcome(request: PairingRequest): Promise<void> {
    const handle = this.pool.get(request.bot);
    if (!handle) return;
    const text = request.kind === "dm" ? "✅ Pairing approved — you're in. Say hi!" : "✅ This group is now connected.";
    await sendRich(handle.bot.api, request.chatId, text);
  }

  /** Deliver literal operator-authored prose to the Telegram conversation. */
  async sendToSession(sessionKey: string, text: string): Promise<DeliveryTarget> {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target) throw new Error("thread has no Telegram delivery target");
    const { channel, chatId, topic } = target;
    const handle = this.pool.get(channel);
    if (!handle) throw new Error(`Telegram channel ${channel} is not running`);
    await sendRich(handle.bot.api, chatId, text, { messageThreadId: topic });
    return { channel: "telegram", bot: channel, chatId, topic };
  }

  /** Drop input a conversation has buffered but not yet turned into a turn.
   * Part of stopping from outside Telegram: aborting the running turn alone
   * would leave a pending burst free to start the next one. */
  discardPending(sessionKey: string): boolean {
    const owner = [...this.pool.bots].find(([name]) => sessionKey.startsWith(`telegram:${name}:`));
    return owner ? owner[1].handle.discardBurst(sessionKey) : false;
  }

  /** Re-prompt conversations whose turn was interrupted by a restart, routing
   * each to the bot that owns its session key. Unknown/removed bots are skipped. */
  wakeInterrupted(turns: { sessionKey: string }[]) {
    for (const { sessionKey } of turns) {
      const owner = [...this.pool.bots].find(([name]) => sessionKey.startsWith(`telegram:${name}:`));
      if (owner) void owner[1].handle.wake(sessionKey);
    }
  }

  /** The picture Telegram draws for a conversation: a forum topic's custom
   *  emoji, or the chat's photo — the group's, or the person's in a DM. Only
   *  for conversations this channel knows: a session key off the street does
   *  not get to make the bot look up arbitrary chats. A topic without an emoji
   *  has no picture; Telegram draws it as a coloured bubble, and so does the
   *  dashboard. With its bot down, whatever was cached is still served. */
  async avatar(sessionKey: string): Promise<Avatar | undefined> {
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

  status(): ChannelStatus[] {
    return [...this.pool.bots.entries()].map(([name, { handle }]) => ({
      type: "telegram" as const,
      name,
      username: handle.username,
      connected: Date.now() - handle.lastPollAt < 90_000,
    }));
  }

  stop() {
    return this.pool.stop();
  }
}

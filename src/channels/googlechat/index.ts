import { logger } from "../../log.ts";
import type { ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import type { Avatar } from "../avatars.ts";
import { BotPool } from "../bots.ts";
import type { Channel, ChannelStatus, DeliveryTarget, ReplyOptions } from "../index.ts";
import type { PairingRequest, PairingStore } from "../pairing.ts";
import { startGoogleChatBot, type BotHandle } from "./bot.ts";
import { parseGoogleChatSessionKey } from "./session-key.ts";

const log = logger("googlechat");

/** Google Chat, one HTTP endpoint per channel configured across workspaces. */
export class GoogleChatChannel implements Channel {
  readonly type = "googlechat";
  private pool: BotPool<BotHandle>;

  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore) {
    this.pool = new BotPool("googlechat", config, { gateway, pairing }, startGoogleChatBot);
  }

  private owner(sessionKey: string): BotHandle | undefined {
    const target = parseGoogleChatSessionKey(sessionKey);
    return target && this.pool.get(target.channel);
  }

  private requiredOwner(sessionKey: string): BotHandle {
    const handle = this.owner(sessionKey);
    if (!handle) throw new Error("Google Chat channel is not running");
    return handle;
  }

  async welcome(request: PairingRequest): Promise<void> {
    await this.pool.get(request.bot)?.welcome(request);
  }

  async sendToSession(sessionKey: string, text: string, options: ReplyOptions = {}): Promise<DeliveryTarget> {
    const target = parseGoogleChatSessionKey(sessionKey);
    if (!target) throw new Error("thread has no Google Chat delivery target");
    await this.requiredOwner(sessionKey).send(sessionKey, text, options);
    return { channel: "googlechat", bot: target.channel, chatId: target.spaceId ?? target.userId!, topic: target.threadId };
  }

  discardPending(sessionKey: string): boolean {
    return this.owner(sessionKey)?.discardBurst(sessionKey) ?? false;
  }

  wakeInterrupted(turns: { sessionKey: string }[]): void {
    for (const { sessionKey } of turns) void this.owner(sessionKey)?.wake(sessionKey).catch((error) => log.warn(String(error)));
  }

  wake(sessionKey: string, text: string, threadId?: string): Promise<void> {
    return this.requiredOwner(sessionKey).wake(sessionKey, text, threadId);
  }

  async avatar(): Promise<Avatar | undefined> {
    return undefined;
  }

  status(): ChannelStatus[] {
    return [...this.pool.bots.entries()].map(([name, { handle }]) => ({
      type: "googlechat" as const,
      name,
      connected: handle.listening(),
    }));
  }

  stop() {
    return this.pool.stop();
  }
}

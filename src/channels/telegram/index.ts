import { isUnresolved, type ChannelConfig, type ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import { PairingStore, type PairingRequest } from "./pairing.ts";
import { startTelegramBot, type BotHandle } from "./bot.ts";
import { parseTelegramSessionKey } from "./session-key.ts";
import { sendRich } from "./rich.ts";
import { logger } from "../../log.ts";

const log = logger("telegram");

export interface BotStatus {
  name: string;
  username?: string;
  connected: boolean;
}

/**
 * Runs one polling bot per telegram channel configured across workspaces and
 * keeps them in sync with config changes (dashboard edits): new channels start,
 * removed/re-tokened ones restart. Allowlist and workspace edits apply live via
 * the config getter.
 */
export class TelegramChannel {
  readonly pairing = new PairingStore();
  private bots = new Map<string, { handle: BotHandle; token: string }>();
  private config: ConfigStore;
  private gateway: Gateway;

  constructor(config: ConfigStore, gateway: Gateway) {
    this.config = config;
    this.gateway = gateway;
    config.on("change", () => this.sync());
    this.sync();
  }

  private find(name: string): { workspace: string; channel: ChannelConfig } | undefined {
    return this.config.channels().find((c) => c.channel.type === "telegram" && c.channel.name === name);
  }

  private sync() {
    const wanted = new Map(
      this.config
        .channels()
        .filter((c) => c.channel.type === "telegram")
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
        log.error(`channel ${name} reuses another channel's token — skipping (Telegram allows one poller per token)`);
        continue;
      }
      log.info(`starting bot ${name}`);
      const handle = startTelegramBot(name, channel.token, {
        gateway: this.gateway,
        pairing: this.pairing,
        botConfig: () => this.find(name)?.channel,
        workspace: () => this.find(name)?.workspace,
        transcribeCommand: () => this.config.resolved.transcription?.command,
        updateGroup: (chatId, mutate) => this.updateEntry(name, (c) => c.groups?.[chatId], mutate),
        updateUser: (userId, mutate) => this.updateEntry(name, (c) => c.users?.[userId], mutate),
      });
      this.bots.set(name, { handle, token: channel.token });
    }
  }

  /** Registry maintenance from live traffic (group titles, topics, user names) —
   * mutates one entry inside the raw config and saves only when `mutate`
   * reports a change. Runs on every message, so the no-op path must stay
   * allocation-free. */
  private updateEntry<T>(channelName: string, pick: (channel: ChannelConfig) => T | undefined, mutate: (entry: T) => boolean) {
    const channel = this.config.channels(this.config.raw).find((c) => c.channel.name === channelName)?.channel;
    const entry = channel && pick(channel);
    if (!entry || !mutate(entry)) return;
    this.config.save(this.config.raw);
  }

  /** Approve a pairing request: allowlist the user (dm) or register the group. */
  async approvePairing(id: string): Promise<PairingRequest> {
    const request = this.pairing.take(id);
    if (!request) throw new Error(`unknown pairing request ${id}`);

    const raw = structuredClone(this.config.raw);
    const channel = this.config.channels(raw).find((c) => c.channel.name === request.bot)?.channel;
    if (!channel) throw new Error(`channel ${request.bot} no longer configured`);

    if (request.kind === "dm") {
      channel.users = { ...channel.users, [String(request.userId)]: { name: request.name, username: request.username } };
    } else {
      channel.groups = { ...channel.groups, [String(request.chatId)]: { requireMention: false, title: request.chatTitle } };
    }
    this.config.save(raw);

    const handle = this.bots.get(request.bot)?.handle;
    if (handle) {
      const text = request.kind === "dm" ? "✅ Pairing approved — you're in. Say hi!" : "✅ This group is now connected.";
      await sendRich(handle.bot.api, request.chatId, text).catch(() => {});
    }
    return request;
  }

  /** Deliver literal operator-authored prose to the Telegram conversation. */
  async sendToSession(sessionKey: string, text: string): Promise<{ bot: string; chatId: number; topic?: number }> {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target) throw new Error("thread has no Telegram delivery target");
    const { channel, chatId, topic } = target;
    const handle = this.bots.get(channel)?.handle;
    if (!handle) throw new Error(`Telegram channel ${channel} is not running`);
    await sendRich(handle.bot.api, chatId, text, { messageThreadId: topic });
    return { bot: channel, chatId, topic };
  }

  /** Re-prompt conversations whose turn was interrupted by a restart, routing
   * each to the bot that owns its session key. Unknown/removed bots are skipped. */
  wakeInterrupted(turns: { sessionKey: string }[]) {
    for (const { sessionKey } of turns) {
      const owner = [...this.bots].find(([name]) => sessionKey.startsWith(`telegram:${name}:`));
      if (owner) void owner[1].handle.wake(sessionKey);
    }
  }

  denyPairing(id: string): PairingRequest {
    const request = this.pairing.take(id);
    if (!request) throw new Error(`unknown pairing request ${id}`);
    return request;
  }

  status(): BotStatus[] {
    return [...this.bots.entries()].map(([name, { handle }]) => ({
      name,
      username: handle.username,
      connected: Date.now() - handle.lastPollAt < 90_000,
    }));
  }

  async stop() {
    await Promise.all([...this.bots.values()].map((b) => b.handle.stop()));
    this.bots.clear();
  }
}

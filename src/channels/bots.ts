import { isUnresolved, type ChannelConfig, type ChannelType, type ConfigStore, type GroupConfig, type UserConfig } from "../config.ts";
import type { Gateway } from "../gateway.ts";
import { logger } from "../log.ts";
import type { PairingStore } from "./pairing.ts";

/** What a running bot needs from the daemon. */
export interface BotDeps {
  gateway: Gateway;
  pairing: PairingStore;
  /** Live view of this channel's config (allowlist edits apply without restart). */
  botConfig: () => ChannelConfig | undefined;
  /** The workspace this channel routes to. */
  workspace: () => string | undefined;
  transcribeCommand: () => string | undefined;
  /** Live view of the auto-failover setting (Models page) — read per failure. */
  autoFailover: () => boolean;
  /** Mutate a registered group's config entry; return true to persist. */
  updateGroup: (id: string, mutate: (group: GroupConfig) => boolean) => void;
  /** Mutate an allowed user's config entry; return true to persist. */
  updateUser: (id: string, mutate: (user: UserConfig) => boolean) => void;
}

/**
 * One running bot per configured channel of a type, kept in sync with config
 * changes (dashboard edits): new channels start, removed/re-tokened ones
 * restart. Allowlist and workspace edits apply live via the config getters.
 */
export class BotPool<H extends { stop(): Promise<void> }> {
  readonly bots = new Map<string, { handle: H; token: string }>();
  private type: ChannelType;
  private config: ConfigStore;
  private deps: Pick<BotDeps, "gateway" | "pairing">;
  private start: (name: string, token: string, deps: BotDeps) => H;
  private log: ReturnType<typeof logger>;

  constructor(type: ChannelType, config: ConfigStore, deps: Pick<BotDeps, "gateway" | "pairing">, start: (name: string, token: string, deps: BotDeps) => H) {
    this.type = type;
    this.config = config;
    this.deps = deps;
    this.start = start;
    this.log = logger(type);
    config.on("change", () => this.sync());
    this.sync();
  }

  find(name: string): { workspace: string; channel: ChannelConfig } | undefined {
    return this.config.channels().find((c) => c.channel.type === this.type && c.channel.name === name);
  }

  get(name: string): H | undefined {
    return this.bots.get(name)?.handle;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.bots.values()].map((b) => b.handle.stop()));
    this.bots.clear();
  }

  private sync() {
    const wanted = new Map(
      this.config
        .channels()
        .filter((c) => c.channel.type === this.type)
        .map((c) => [c.channel.name, c.channel]),
    );

    for (const [name, entry] of this.bots) {
      const next = wanted.get(name);
      if (!next || next.token !== entry.token) {
        this.log.info(`stopping bot ${name}`);
        void entry.handle.stop();
        this.bots.delete(name);
      }
    }

    for (const [name, channel] of wanted) {
      if (this.bots.has(name)) continue;
      if (isUnresolved(channel.token)) {
        this.log.warn(`channel ${name} has an unresolved token, skipping`);
        continue;
      }
      // Telegram allows one poller per token, and two Discord connections
      // would answer every message twice.
      if ([...this.bots.values()].some((b) => b.token === channel.token)) {
        this.log.error(`channel ${name} reuses another channel's token — skipping`);
        continue;
      }
      this.log.info(`starting bot ${name}`);
      const handle = this.start(name, channel.token, {
        ...this.deps,
        botConfig: () => this.find(name)?.channel,
        workspace: () => this.find(name)?.workspace,
        transcribeCommand: () => this.config.resolved.transcription?.command,
        autoFailover: () => this.config.resolved.autoFailover === true,
        updateGroup: (id, mutate) => this.updateEntry(name, (c) => c.groups?.[id], mutate),
        updateUser: (id, mutate) => this.updateEntry(name, (c) => c.users?.[id], mutate),
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
}

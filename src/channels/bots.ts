import { isUnresolved, type ChannelConfig, type ChannelType, type ConfigStore, type GroupConfig, type UserConfig } from "../config.ts";
import type { Gateway } from "../gateway.ts";
import { logger } from "../log.ts";
import type { Avatar } from "./avatars.ts";
import type { Channel, ChannelDestination, ChannelStatus, CreatedConversation, DeliveryTarget, ReplyOptions } from "./index.ts";
import type { PairingRequest, PairingStore } from "./pairing.ts";
import { DeliveryBlocked } from "./replies.ts";
import { parseSessionKey, type ConversationTarget } from "./session-key.ts";

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

/** What every running bot offers the daemon, whatever its platform. The
 *  optional half is what only some platforms can do. */
export interface ChatBot {
  /** How it shows in the dashboard: its handle, and whether it is reachable now. */
  status(): { username?: string; connected: boolean };
  /** Deliver literal text to one of its conversations. */
  send(sessionKey: string, markdown: string, options?: ReplyOptions): Promise<unknown>;
  /** Start a turn nobody typed; without `text`, resume one a restart cut off. */
  wake(sessionKey: string, text?: string, threadId?: string): Promise<void>;
  /** Drop a conversation's buffered input before it becomes a turn. */
  discardBurst(sessionKey: string): boolean;
  /** Tell an approved requester they're in. */
  welcome(request: PairingRequest): Promise<void>;
  stop(): Promise<void>;
  openThread?(sessionKey: string, name: string, text: string, persistent?: boolean): Promise<CreatedConversation>;
  prompt?(sessionKey: string, text: string): Promise<void>;
  archive?(sessionKey: string): Promise<void>;
  destinations?(): Promise<ChannelDestination[]>;
  describe?(sessionKey: string): Promise<ChannelDestination>;
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

/**
 * A chat platform as the daemon sees it: the bots of every channel configured
 * for it, each call routed to the bot its session key names. What a platform
 * adds on top is what only it knows — the pictures it draws, how its ids read.
 */
export class BotChannel<H extends ChatBot> implements Channel {
  readonly type: ChannelType;
  protected pool: BotPool<H>;
  /** The platform's name as error messages spell it. */
  private label: string;
  /** Whether a failed send provably never reached the platform. Without it
   *  every failure is retried. */
  private canRetrySend?: (error: unknown) => boolean;
  private log: ReturnType<typeof logger>;

  constructor(
    type: ChannelType,
    label: string,
    config: ConfigStore,
    deps: Pick<BotDeps, "gateway" | "pairing">,
    start: (name: string, token: string, deps: BotDeps) => H,
    canRetrySend?: (error: unknown) => boolean,
  ) {
    this.type = type;
    this.label = label;
    this.canRetrySend = canRetrySend;
    this.log = logger(type);
    this.pool = new BotPool(type, config, deps, start);
  }

  /** The conversation a session key of this platform names. */
  protected target(sessionKey: string): ConversationTarget | undefined {
    const target = parseSessionKey(sessionKey);
    return target?.type === this.type ? target : undefined;
  }

  /** The running bot a session key belongs to. */
  protected bot(sessionKey: string): H | undefined {
    const target = this.target(sessionKey);
    return target && this.pool.get(target.channel);
  }

  private required(sessionKey: string): H {
    const bot = this.bot(sessionKey);
    if (!bot) throw new Error(`${this.label} channel is not running`);
    return bot;
  }

  /** Where a delivery landed, in the platform's own ids. */
  protected deliveryTarget(target: ConversationTarget): DeliveryTarget {
    return { channel: this.type, bot: target.channel, chatId: target.owner.id, topic: target.topic };
  }

  status(): ChannelStatus[] {
    return [...this.pool.bots.entries()].map(([name, { handle }]) => ({ type: this.type, name, ...handle.status() }));
  }

  /** Deliver literal operator-authored prose to the conversation. */
  async sendToSession(sessionKey: string, text: string, options: ReplyOptions = {}): Promise<DeliveryTarget> {
    const target = this.target(sessionKey);
    if (!target) throw new Error(`thread has no ${this.label} delivery target`);
    const bot = this.pool.get(target.channel);
    if (!bot) throw new Error(`${this.label} channel ${target.channel} is not running`);
    try {
      await bot.send(sessionKey, text, options);
    } catch (error) {
      // A checkpointed delivery is retried on its own: one that may already
      // have landed has to wait for someone to look, or it lands twice.
      if (options.onChunk && this.canRetrySend && !this.canRetrySend(error)) throw new DeliveryBlocked(`${this.label} send needs inspection: ${error}`);
      throw error;
    }
    return this.deliveryTarget(target);
  }

  openThread(sessionKey: string, name: string, text: string, persistent = false): Promise<CreatedConversation> {
    const bot = this.required(sessionKey);
    if (!bot.openThread) throw new Error("this channel cannot open threads");
    return bot.openThread(sessionKey, name, text, persistent);
  }

  async prompt(sessionKey: string, text: string): Promise<void> {
    const bot = this.required(sessionKey);
    if (!bot.prompt) throw new Error("this channel cannot start remote turns");
    await bot.prompt(sessionKey, text);
  }

  async archive(sessionKey: string): Promise<void> {
    const bot = this.required(sessionKey);
    if (!bot.archive) throw new Error("this channel cannot archive conversations");
    await bot.archive(sessionKey);
  }

  async destinations(): Promise<ChannelDestination[]> {
    return (await Promise.all([...this.pool.bots.values()].map(({ handle }) => handle.destinations?.() ?? []))).flat();
  }

  describe(sessionKey: string): Promise<ChannelDestination> {
    const bot = this.required(sessionKey);
    if (!bot.describe) throw new Error("this channel cannot describe destinations");
    return bot.describe(sessionKey);
  }

  /** Drop input a conversation has buffered but not yet turned into a turn.
   *  Part of stopping from outside the chat: aborting the running turn alone
   *  would leave a pending burst free to start the next one. */
  discardPending(sessionKey: string): boolean {
    return this.bot(sessionKey)?.discardBurst(sessionKey) ?? false;
  }

  /** Re-prompt conversations whose turn was interrupted by a restart, routing
   *  each to the bot that owns its session key. Unknown/removed bots are skipped. */
  wakeInterrupted(turns: { sessionKey: string }[]): void {
    for (const { sessionKey } of turns) void this.bot(sessionKey)?.wake(sessionKey).catch((error) => this.log.warn(String(error)));
  }

  wake(sessionKey: string, text: string, threadId?: string): Promise<void> {
    const bot = this.bot(sessionKey);
    if (!bot) return Promise.reject(new Error(`no running ${this.label} bot owns ${sessionKey}`));
    return bot.wake(sessionKey, text, threadId);
  }

  /** The picture the platform draws for a conversation it knows; none unless
   *  the platform says otherwise. */
  async avatar(_sessionKey: string): Promise<Avatar | undefined> {
    return undefined;
  }

  async welcome(request: PairingRequest): Promise<void> {
    await this.pool.get(request.bot)?.welcome(request);
  }

  stop(): Promise<void> {
    return this.pool.stop();
  }
}

/** Sender-level access: is this person allowed here at all? A DM needs the
 *  person allowlisted; a group needs registering, and then listens to its
 *  allowed users. Mention gating is each platform's own, and separate. */
export function senderAccess(config: ChannelConfig, userId: string, groupId: string | undefined): "ok" | "pair" | "ignore" {
  if (groupId === undefined) return config.users?.[userId] ? "ok" : "pair";
  // Unregistered group → surface a pairing request instead of silence.
  if (!config.groups?.[groupId]) return "pair";
  const allowed = (config.groupAllowedUsers ?? Object.keys(config.users ?? {})).map(String);
  return allowed.includes(userId) ? "ok" : "ignore";
}

/** Names self-heal from traffic, like group titles: an allowed user's entry
 *  takes the name and handle their latest message carried. `also` is whatever
 *  else the platform files under the person. */
export function healUser(deps: Pick<BotDeps, "updateUser">, id: string, seen: { name?: string; username?: string }, also?: (user: UserConfig) => boolean): void {
  deps.updateUser(id, (user) => {
    let changed = false;
    if (seen.name && user.name !== seen.name) {
      user.name = seen.name;
      changed = true;
    }
    if (seen.username && user.username !== seen.username) {
      user.username = seen.username;
      changed = true;
    }
    return (also?.(user) ?? false) || changed;
  });
}

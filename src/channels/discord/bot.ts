import { join } from "node:path";
import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIChannel,
  type APIGuild,
  type APIInteraction,
  type APIRole,
  type APIMessage,
  type APIUser,
  type GatewayDispatchPayload,
  type GatewayGuildCreateDispatchData,
  type GatewayMessageCreateDispatchData,
} from "discord-api-types/v10";
import type { ChannelConfig } from "../../config.ts";
import { formatInboundBody } from "../../media-store.ts";
import { logger } from "../../log.ts";
import { STATE_DIR } from "../../paths.ts";
import { keyedLane } from "../../util.ts";
import { capped } from "../avatars.ts";
import { healUser, senderAccess, type BotDeps, type ChatBot } from "../bots.ts";
import type { ChannelDestination, CreatedConversation, ReplyOptions } from "../index.ts";
import { BACKGROUND_STOP_PREFIX } from "../background.ts";
import { COMMANDS } from "../commands.ts";
import { Conversations, type TurnSurface } from "../conversations.ts";
import { FAILOVER_PREFIX } from "../failover.ts";
import type { PairingRequest } from "../pairing.ts";
import { topicChain } from "../session-key.ts";
import { compactReplyQuote, foldDisplayName, sanitizeContextLabel } from "../text.ts";
import { BACKFILL_MAX_PER_CHANNEL, BACKFILL_WINDOW_MS, isNewer, missedMessages, snowflakeAt, Watermark } from "./backfill.ts";
import { DiscordGateway } from "./gateway.ts";
import { collectInboundMedia } from "./media.ts";
import { DiscordRest } from "./rest.ts";
import { discordChunks } from "./markdown.ts";
import { disableComponents, sendMessage } from "./send.ts";
import { DiscordTurnStatus, STOP_BUTTON_ID } from "./status.ts";
import { discordSessionKey, parseDiscordSessionKey } from "./session-key.ts";
import { discordTool, type DiscordThreadRequest } from "./tool.ts";

// Message Content is privileged: it has to be switched on for the bot in the
// Developer Portal, or the gateway refuses the connection (close 4014).
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.DirectMessages | GatewayIntentBits.MessageContent;
const ACK_REACTION = "👀";
// The heartbeat runs every ~41 s; two missed acks is a dead connection.
const HEALTHY_ACK_MS = 100_000;
const CDN = "https://cdn.discordapp.com";
// How stale the on-disk "still listening" mark may get; a restart replays from it.
const WATERMARK_EVERY_MS = 15_000;

/** Where a turn lands, distilled from a live event or a bare session key (a
 * wake-up after restart has nothing else to read from). */
interface Target {
  /** The Discord channel messages go to: a server channel, a thread, a DM. */
  channelId: string;
  /** Set in a server; a DM has none. */
  guildId?: string;
  /** The person on the other end of a DM. */
  userId?: string;
  /** Message to ack/reply to, when a specific one triggered the turn. */
  triggerMessageId?: string;
}

/** A server channel or thread, as far as naming and replying need to know it. */
interface ChannelInfo {
  type: ChannelType;
  /** As the server shows it: `#general` for a channel, bare for a category or a thread. */
  title?: string;
  guildId?: string;
  /** The category a channel sits in, the channel a thread hangs off. */
  parentId?: string;
}

const THREADS = new Set<ChannelType>([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

export interface BotHandle extends ChatBot {
  name: string;
  username?: string;
  connected(): boolean;
  openThread(sessionKey: string, name: string, text: string, persistent?: boolean): Promise<CreatedConversation>;
  prompt(sessionKey: string, text: string): Promise<void>;
  archive(sessionKey: string): Promise<void>;
  destinations(): Promise<ChannelDestination[]>;
  describe(sessionKey: string): Promise<ChannelDestination>;
  /** The picture of a person (DM) or a server, as stored bytes. */
  picture(kind: "user" | "guild", id: string): Promise<Buffer | undefined>;
}

export function startDiscordBot(name: string, token: string, deps: BotDeps, io?: { rest: DiscordRest; gateway: DiscordGateway }): BotHandle {
  const log = logger(`discord/${name}`);
  const rest = io?.rest ?? new DiscordRest(token);
  const gateway = io?.gateway ?? new DiscordGateway(token, INTENTS, log);
  let self: APIUser | undefined;
  let commandsSynced = false;

  const guilds = new Map<string, Pick<APIGuild, "name" | "icon">>();
  // Role names, for spelling out role mentions; and the role Discord creates
  // for this bot in each server. Picking "@Mortar" from the client's list
  // often picks that role rather than the bot itself, and it means the same.
  const roles = new Map<string, string>();
  const ownRoles = new Set<string>();
  const channels = new Map<string, ChannelInfo>();
  // A DM's session is keyed by the person; sending needs the DM channel's id.
  const dmChannels = new Map<string, string>();

  const handle: BotHandle = {
    name,
    get username() {
      return self?.username;
    },
    connected: () => gateway.ready && Date.now() - gateway.lastAckAt < HEALTHY_ACK_MS,
    status: () => ({ username: self?.username, connected: handle.connected() }),
    wake: (sessionKey, text, threadId) => conversations.wake(sessionKey, text, threadId),
    discardBurst: (sessionKey) => conversations.bursts.discard(sessionKey),
    send,
    openThread,
    prompt,
    archive,
    destinations,
    describe,
    welcome,
    picture,
    stop,
  };

  const sessionKeyFor = (target: Target) =>
    target.guildId ? discordSessionKey(name, { guildId: target.guildId, channelId: target.channelId }) : discordSessionKey(name, { userId: target.userId! });

  const conversations = new Conversations<Target>({
    type: "discord",
    name,
    deps,
    log,
    sessionKey: sessionKeyFor,
    targetOf,
    surface,
    describe: describeConversation,
    capabilities: [
      "Discord markdown (headings up to ###, lists, code blocks, ||spoilers||; tables arrive as monospace blocks)",
      "buttons",
      "files",
      "reactions — via the discord tool",
    ],
    tools: ({ channelId }, onSent) => [discordTool(rest, channelId, onSent, async (request) => {
      const created = await createThread(channelId, request);
      if (created.warning) return `Thread created: ${created.url}. NOT started: ${created.warning}. Do not create it again.`;
      return `Thread created: ${created.url}\nsession_key: ${created.sessionKey}\n${request.start ? "Agent started independently; answers will arrive in that thread and will not come back to this conversation." : "Opening context recorded; waiting for a user message."}`;
    })],
    // An archive asked for mid-turn waits for the turn to be over.
    afterTurn: async (_target, sessionKey) => {
      if (deps.gateway.threads.current(sessionKey)?.archiveRequested) {
        await archive(sessionKey).catch((error) => log.warn(`archive remains pending in ${sessionKey}: ${error}`));
      }
    },
  });
  // Per-conversation ordering of message *preparation* (downloads,
  // transcription); turns run outside it, so a message landing mid-turn still
  // reaches the runner and steers.
  const lanes = new Map<string, Promise<unknown>>();
  const archiveTimer = setInterval(() => void flushArchives(), 60_000);
  archiveTimer.unref();
  const watermark = new Watermark(join(STATE_DIR, "discord", `${name}.json`));
  const listening = () => {
    if (!handle.connected()) return;
    try {
      watermark.save(Date.now());
    } catch (error) {
      log.warn(`could not save the watermark: ${error}`);
    }
  };
  const watermarkTimer = setInterval(listening, WATERMARK_EVERY_MS);
  watermarkTimer.unref();
  // A READY (unlike RESUMED) starts a session that replays nothing: whatever
  // was sent since the watermark is fetched instead, guild by guild as each
  // one arrives.
  let backfill: { since: string; guilds: Set<string> } | undefined;

  gateway.on("ready", (ready) => {
    self = ready.user;
    log.info(`@${self.username} connected`);
    if (watermark.value !== undefined) {
      const since = snowflakeAt(Math.max(watermark.value, Date.now() - BACKFILL_WINDOW_MS));
      backfill = { since, guilds: new Set(ready.guilds.map((guild) => guild.id)) };
      void backfillDms(since).catch((error) => log.warn(`DM backfill failed: ${error}`));
    }
    void flushArchives();
    if (!commandsSynced) {
      commandsSynced = true;
      void syncCommands(ready.application.id).catch((error) => {
        commandsSynced = false;
        log.warn(`command sync failed: ${error}`);
      });
    }
  });
  gateway.on("fatal", (code) => {
    if (code === 4014) log.error("Discord refused the Message Content intent — enable it under Bot → Privileged Gateway Intents in the Developer Portal");
    else if (code === 4004) log.error("Discord rejected the bot token");
  });
  gateway.on("dispatch", (payload) => {
    try {
      dispatch(payload);
    } catch (error) {
      log.error(`event ${payload.t} failed: ${error}`);
    }
  });
  gateway.start();

  /** The client's "/" menu: global commands, usable in servers and in DMs. */
  async function syncCommands(applicationId: string) {
    await rest.request("PUT", `/applications/${applicationId}/commands`, {
      body: COMMANDS.map((c) => ({ name: c.command, description: c.description, type: 1, contexts: [0, 1] })),
    });
  }

  function dispatch(payload: GatewayDispatchPayload) {
    switch (payload.t) {
      case GatewayDispatchEvents.GuildCreate:
        rememberGuild(payload.d);
        if (backfill?.guilds.delete(payload.d.id)) {
          void backfillGuild(payload.d, backfill.since).catch((error) => log.warn(`backfill of server ${payload.d.id} failed: ${error}`));
        }
        return;
      case GatewayDispatchEvents.GuildUpdate:
        guilds.set(payload.d.id, { name: payload.d.name, icon: payload.d.icon });
        return;
      case GatewayDispatchEvents.GuildRoleCreate:
      case GatewayDispatchEvents.GuildRoleUpdate:
        return rememberRole(payload.d.role);
      case GatewayDispatchEvents.ChannelCreate:
      case GatewayDispatchEvents.ChannelUpdate:
      case GatewayDispatchEvents.ThreadCreate:
      case GatewayDispatchEvents.ThreadUpdate:
        return rememberChannel(payload.d);
      case GatewayDispatchEvents.MessageCreate:
        return void handleMessage(payload.d).catch((error) => log.error(`message failed: ${error}`));
      case GatewayDispatchEvents.InteractionCreate:
        return void handleInteraction(payload.d).catch((error) => log.error(`interaction failed: ${error}`));
    }
  }

  function rememberGuild(guild: GatewayGuildCreateDispatchData) {
    if ("unavailable" in guild && guild.unavailable) return;
    guilds.set(guild.id, { name: guild.name, icon: guild.icon });
    for (const role of guild.roles) rememberRole(role);
    for (const channel of [...(guild.channels ?? []), ...(guild.threads ?? [])]) rememberChannel({ ...channel, guild_id: guild.id });
  }

  function rememberRole(role: APIRole) {
    roles.set(role.id, role.name);
    if (role.tags?.bot_id && role.tags.bot_id === self?.id) ownRoles.add(role.id);
  }

  function rememberChannel(channel: Pick<APIChannel, "id" | "type"> & { name?: string | null; guild_id?: string; parent_id?: string | null }) {
    if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) return;
    const bare = channel.type === ChannelType.GuildCategory || THREADS.has(channel.type);
    channels.set(channel.id, {
      type: channel.type,
      title: channel.name ? (bare ? channel.name : `#${channel.name}`) : undefined,
      guildId: channel.guild_id,
      parentId: channel.parent_id ?? undefined,
    });
  }

  /** A channel's name, from the gateway's snapshot or — for one created while
   *  disconnected — from the API. */
  async function channelInfo(channelId: string): Promise<ChannelInfo | undefined> {
    const known = channels.get(channelId);
    if (known) return known;
    try {
      const channel = await rest.get<APIChannel & { guild_id?: string }>(`/channels/${channelId}`);
      rememberChannel(channel);
      return channels.get(channelId);
    } catch (error) {
      log.debug(`channel ${channelId} unavailable: ${error}`);
      return undefined;
    }
  }

  async function createThread(channelId: string, request: DiscordThreadRequest): Promise<CreatedConversation> {
    const origin = await channelInfo(channelId);
    if (!origin?.guildId) throw new Error("threads need a server channel, not a DM");
    if (origin.type === ChannelType.PrivateThread) throw new Error("cannot fan out a private thread into public conversations");
    const parentId = THREADS.has(origin.type) ? origin.parentId : channelId;
    const parent = parentId && await channelInfo(parentId);
    const forum = parent && (parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia);
    if (!parentId || !parent || (!forum && parent.type !== ChannelType.GuildText)) {
      throw new Error("create threads in a text channel or a forum post");
    }
    if (!deps.botConfig()?.groups?.[origin.guildId]) throw new Error("server is no longer allowed");
    if (!request.message.trim()) throw new Error("thread needs an opening message");
    const chunks = forum ? discordChunks(request.message) : [];
    const thread = await rest.request<APIChannel>("POST", `/channels/${parentId}/threads`, {
      body: {
        name: request.name.trim(),
        auto_archive_duration: 10080,
        ...(forum
          ? { message: { content: chunks[0], allowed_mentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds } }
          : { type: ChannelType.PublicThread }),
      },
      creates: true,
    });
    const target = { channelId: thread.id, guildId: origin.guildId };
    const sessionKey = sessionKeyFor(target);
    const created: CreatedConversation = { sessionKey, url: `https://discord.com/channels/${origin.guildId}/${thread.id}`, recorded: false };
    try {
      rememberChannel({ ...thread, guild_id: origin.guildId, parent_id: parentId });
      await maintainGroupRegistry(origin.guildId, thread.id);
      const conversation = deps.gateway.newThread(sessionKey, deps.workspace());
      created.threadId = conversation.id;
      if (request.persistent) deps.gateway.threads.update(conversation.id, { persistent: true });
      const delivery = await deps.gateway.deliverOutbound(conversation.id, request.message, async () => {
        if (forum) {
          for (const content of chunks.slice(1)) await sendMessage(rest, thread.id, content);
        } else {
          await sendMessage(rest, thread.id, request.message);
        }
      });
      created.recorded = delivery.recorded;
      created.warning = delivery.warning;
      if (!delivery.recorded) return created;
      if (request.start) {
        void conversations.runTurn(target, "[Task delegated from another conversation]\nCarry out the task in the opening message above. Work only on this subject; ask any necessary questions here.", [])
          .catch((error) => log.error(`delegated turn in ${sessionKey} failed: ${error}`));
      }
      return created;
    } catch (error) {
      return { ...created, warning: `setup failed: ${error}` };
    }
  }

  async function backfillGuild(guild: GatewayGuildCreateDispatchData, since: string) {
    if ("unavailable" in guild && guild.unavailable) return;
    if (!deps.botConfig()?.groups?.[guild.id]) return;
    for (const channel of [...(guild.channels ?? []), ...(guild.threads ?? [])]) {
      if ("last_message_id" in channel && isNewer(channel.last_message_id, since)) await replay(channel.id, guild.id, since);
    }
  }

  async function backfillDms(since: string) {
    for (const userId of Object.keys(deps.botConfig()?.users ?? {})) {
      const dm = await rest.request<APIChannel & { last_message_id?: string | null }>("POST", "/users/@me/channels", { body: { recipient_id: userId } });
      dmChannels.set(userId, dm.id);
      if (isNewer(dm.last_message_id, since)) await replay(dm.id, undefined, since);
    }
  }

  async function replay(channelId: string, guildId: string | undefined, since: string) {
    const missed = await missedMessages((path) => rest.get(path), channelId, since);
    if (!missed) {
      log.warn(`over ${BACKFILL_MAX_PER_CHANNEL} messages in ${channelId} while disconnected — not answering them`);
      return;
    }
    if (missed.length) log.info(`replaying ${missed.length} message(s) sent to ${channelId} while disconnected`);
    for (const message of missed) await handleMessage({ ...message, guild_id: guildId });
  }

  async function handleMessage(message: GatewayMessageCreateDispatchData) {
    const config = deps.botConfig();
    // Bots (this one included) and webhooks never start turns: two agents
    // answering each other in a channel is a loop nobody stops.
    if (!config || !self || message.author.bot || message.webhook_id) return;
    if (conversations.seen(message.channel_id, message.id)) return;
    const author = message.author;
    const guildId = message.guild_id;
    const target: Target = guildId
      ? { channelId: message.channel_id, guildId, triggerMessageId: message.id }
      : { channelId: message.channel_id, userId: author.id, triggerMessageId: message.id };
    if (!guildId) dmChannels.set(author.id, message.channel_id);

    // Off the message's path: naming waits on the API at worst, and the
    // preparation lane below must be entered in arrival order.
    if (guildId && config.groups?.[guildId]) void maintainGroupRegistry(guildId, message.channel_id);

    const access = checkAccess(message, config);
    if (access === "pair") return offerPairing(message);
    if (access === "ignore") return;

    // Names self-heal from traffic, like server and channel names.
    healUser(deps, author.id, { name: displayName(author), username: author.username });

    const key = sessionKeyFor(target);
    const text = readableContent(message);
    // The slash commands are interactions; these are the same typed as text.
    const command = text.match(/^\/(\w+)\s*$/)?.[1];
    const answerCommand = async () => {
      const answer = command && (await conversations.command(command, key));
      if (!answer) return false;
      await sendMessage(rest, message.channel_id, answer, { replyTo: message.id }).catch((error) => log.warn(`command reply failed: ${error}`));
      return true;
    };
    // /stop bypasses the preparation lane: it must reach the gateway without
    // waiting behind a slow transcription.
    if (command === "stop") return void (await answerCommand());

    const release = conversations.bursts.prepare(key);
    try {
      await keyedLane(lanes, key, async () => {
        if (await answerCommand()) return;
        const media = await collectInboundMedia(message.attachments, deps.transcribeCommand());
        const body = formatInboundBody(text, media);
        if (!body.trim() && !media.images.length) return;
        // Ack now — the burst window delays the turn, not the receipt.
        void rest.request("PUT", `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(ACK_REACTION)}/@me`).catch(() => {});
        conversations.bursts.enqueue(key, target, formatDiscordInboundPrompt(message, body, self!.id), media.images);
      });
    } finally {
      release();
    }
  }

  /** The text with mentions spelled the way the person saw them: `<@123>` means
   *  nothing to the model, `@gabriel` does. Its own mention is just the knock. */
  function readableContent(message: GatewayMessageCreateDispatchData): string {
    let text = message.content;
    for (const user of message.mentions) {
      const replacement = user.id === self?.id ? "" : `@${displayName(user) || user.username}`;
      text = text.replaceAll(`<@${user.id}>`, replacement).replaceAll(`<@!${user.id}>`, replacement);
    }
    text = text.replaceAll(/<@&(\d+)>/g, (raw, id: string) => {
      if (ownRoles.has(id)) return "";
      const role = roles.get(id);
      return role ? `@${role}` : raw;
    });
    text = text.replaceAll(/<#(\d+)>/g, (raw, id: string) => {
      return channels.get(id)?.title ?? raw;
    });
    return text.trim();
  }

  function checkAccess(message: GatewayMessageCreateDispatchData, config: ChannelConfig): "ok" | "pair" | "ignore" {
    const access = senderAccess(config, message.author.id, message.guild_id);
    if (access !== "ok" || !message.guild_id) return access;
    if (config.groups![message.guild_id]!.requireMention === false) return "ok";
    // A reply to the bot counts: answering it is talking to it.
    return addressesBot(message, self!.id, ownRoles) ? "ok" : "ignore";
  }

  /** Keep the registry in sync with live traffic: the server's name heals on
   *  any message; a channel or thread registers itself the first time it
   *  speaks, along with what it sits in — a thread's channel, a channel's
   *  category — so instructions set on those reach it. Names and nesting heal
   *  the same way. Saves only when something changed. */
  async function maintainGroupRegistry(guildId: string, channelId: string) {
    const guildName = guilds.get(guildId)?.name;
    const chain: { id: string; info?: ChannelInfo }[] = [];
    for (let id: string | undefined = channelId; id && chain.length < 3; ) {
      const info = await channelInfo(id);
      chain.push({ id, info });
      id = info?.parentId;
    }
    deps.updateGroup(guildId, (group) => {
      let changed = false;
      if (guildName && group.title !== guildName) {
        group.title = guildName;
        changed = true;
      }
      const topics = (group.topics ??= {});
      for (const { id, info } of chain) {
        if (!topics[id]) {
          topics[id] = {};
          changed = true;
        }
        const topic = topics[id];
        if (info?.title && topic.title !== info.title) {
          topic.title = info.title;
          changed = true;
        }
        if (info && info.parentId !== topic.parent) {
          if (info.parentId) topic.parent = info.parentId;
          else delete topic.parent;
          changed = true;
        }
      }
      return changed;
    });
  }

  async function offerPairing(message: GatewayMessageCreateDispatchData) {
    const author = message.author;
    const guildId = message.guild_id;
    const request = await conversations.knock({
      kind: guildId ? "group" : "dm",
      userId: author.id,
      chatId: guildId ?? author.id,
      chatTitle: guildId ? guilds.get(guildId)?.name : undefined,
      origin: guildId ? message.channel_id : undefined,
      username: author.username,
      displayName: author.global_name ?? author.username,
      photo: async () => {
        const photo = guildId ? await picture("guild", guildId) : await picture("user", author.id, author.avatar);
        return photo && `data:image/png;base64,${photo.toString("base64")}`;
      },
    });
    if (!request) return; // already pending; stay quiet instead of spamming
    log.info(`pairing request (${request.kind}) from ${author.id} (@${author.username})${guildId ? ` in server ${guildId}` : ""}`);
    // A server stays silent — the request just shows up in the dashboard.
    if (!guildId) {
      await sendMessage(rest, message.channel_id, "This bot is private. I've asked the owner to approve you — hang tight.").catch(() => {});
    }
  }

  async function handleInteraction(interaction: APIInteraction) {
    const config = deps.botConfig();
    const user = interaction.member?.user ?? interaction.user;
    const channelId = interaction.channel?.id ?? interaction.channel_id;
    if (!config || !user || !channelId) return;
    const guildId = interaction.guild_id;
    const target: Target = guildId ? { channelId, guildId } : { channelId, userId: user.id };
    if (!guildId) dmChannels.set(user.id, channelId);
    // Discord tells the user itself when an acknowledgment misses its window.
    const respond = async (body: unknown) => {
      try {
        await rest.acknowledge(interaction.id, interaction.token, body);
        return true;
      } catch (error) {
        log.warn(`interaction acknowledgment failed: ${error}`);
        return false;
      }
    };

    // Same access policy as messages, minus the mention gate (a command or a
    // press is explicit).
    if (senderAccess(config, user.id, guildId) !== "ok") {
      await respond({ type: InteractionResponseType.ChannelMessageWithSource, data: { content: "This bot is private.", flags: MessageFlags.Ephemeral } });
      return;
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
      const sessionKey = sessionKeyFor(target);
      log.info(`command /${interaction.data.name} in ${sessionKey}`);
      // Answer within Discord's three seconds, then take the time the command
      // needs (/usage asks every provider).
      const acknowledged = await respond({ type: InteractionResponseType.DeferredChannelMessageWithSource });
      const answer = (await conversations.command(interaction.data.name, sessionKey)) ?? "Unknown command.";
      await answerCommand(rest, channelId, interaction, acknowledged, answer);
      return;
    }

    if (interaction.type === InteractionType.MessageComponent) {
      const data = interaction.data.custom_id;
      if (data.startsWith(BACKGROUND_STOP_PREFIX)) {
        await respond({ type: InteractionResponseType.DeferredMessageUpdate });
        conversations.stopBackground(sessionKeyFor(target), data);
        return;
      }
      if (data === STOP_BUTTON_ID) {
        // The card redraws itself as stopped once the turn winds down; the
        // press only needs acknowledging.
        await respond({ type: InteractionResponseType.DeferredMessageUpdate });
        const sessionKey = sessionKeyFor(target);
        log.info(`stop pressed in ${sessionKey}`);
        conversations.bursts.discard(sessionKey);
        await deps.gateway.interrupt(sessionKey);
        return;
      }
      // A pressed row has done its job: grey it out so the same action can't
      // be fired twice (and so the chat records which option was taken). This
      // is also the answer Discord waits for.
      const components = disableComponents(interaction.message.components, data);
      if (!await respond({ type: InteractionResponseType.UpdateMessage, data: { components } })) {
        await rest.request("PATCH", `/channels/${channelId}/messages/${interaction.message.id}`, { body: { components } })
          .catch((error) => log.warn(`could not disable pressed buttons: ${error}`));
      }
      if (data.startsWith(FAILOVER_PREFIX)) {
        if (!conversations.retryOnFallback(data, target)) {
          void sendMessage(rest, target.channelId, "⚠️ That retry is no longer on the table — send the message again.").catch(() => {});
        }
        return;
      }
      // The marker on a line of its own is the dashboard's press prompt too, and
      // what lets the transcript draw it as a caption instead of as prose.
      void conversations.runTurn(target, `[inline button pressed]\n${data}`, []);
    }
  }

  /** Open the chat for one turn: a status card under the message that
   * triggered it, and replies threaded onto that message. */
  function surface(target: Target): TurnSurface {
    const { channelId } = target;
    const status = new DiscordTurnStatus(rest, channelId, target.triggerMessageId);
    return {
      status,
      attach: (title, stopId) => status.attach(title, stopId),
      send: (markdown, options) => sendMessage(rest, channelId, markdown, {
        replyTo: options.reply ? target.triggerMessageId : undefined,
        buttons: options.buttons,
        silent: options.silent,
      }),
    };
  }

  function describeConversation(target: Target, config: ChannelConfig | undefined): string {
    if (!target.guildId) {
      const user = config?.users?.[target.userId!];
      return `DM with ${user?.name || "user"}${user?.username ? ` (@${user.username})` : ""}`;
    }
    const group = config?.groups?.[target.guildId];
    const server = group?.title ?? guilds.get(target.guildId)?.name ?? target.guildId;
    const path = topicChain(group, target.channelId).reverse().map((topic) => topic.title).filter(Boolean);
    return `server "${server}", ${path.length ? path.join(" › ") : `channel ${target.channelId}`}`;
  }

  /** A session key back into a target — for a wake-up or a literal send, which
   *  have no live event to read from. */
  async function targetOf(sessionKey: string): Promise<Target | undefined> {
    const parsed = parseDiscordSessionKey(sessionKey);
    if (!parsed || parsed.channel !== name) return undefined;
    if (parsed.guildId) return { channelId: parsed.channelId!, guildId: parsed.guildId };
    return { channelId: await dmChannel(parsed.userId!), userId: parsed.userId };
  }

  function destination(channel: APIChannel & { guild_id?: string; name?: string | null; parent_id?: string | null }, guildId: string): ChannelDestination {
    const key = (id: string) => sessionKeyFor({ channelId: id, guildId });
    return {
      sessionKey: key(channel.id),
      title: channel.name ?? channel.id,
      kind: channel.type === ChannelType.GuildCategory ? "category"
        : channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia ? "forum"
        : THREADS.has(channel.type) ? "thread" : "channel",
      parent: channel.parent_id ? key(channel.parent_id) : undefined,
      groupTitle: deps.botConfig()?.groups?.[guildId]?.title ?? guilds.get(guildId)?.name,
    };
  }

  async function destinations(): Promise<ChannelDestination[]> {
    const result: ChannelDestination[] = [];
    for (const guildId of Object.keys(deps.botConfig()?.groups ?? {})) {
      const list = await rest.get<APIChannel[]>(`/guilds/${guildId}/channels`);
      for (const channel of list) result.push(destination(channel, guildId));
    }
    return result;
  }

  async function describe(sessionKey: string): Promise<ChannelDestination> {
    const parsed = parseDiscordSessionKey(sessionKey);
    if (!parsed?.guildId || parsed.channel !== name || !deps.botConfig()?.groups?.[parsed.guildId]) throw new Error("server is not allowed");
    const channel = await rest.get<APIChannel & { guild_id?: string }>(`/channels/${parsed.channelId}`);
    if (channel.guild_id !== parsed.guildId) throw new Error("channel does not belong to this server");
    rememberChannel(channel);
    return destination(channel, parsed.guildId);
  }

  async function serverTarget(sessionKey: string): Promise<Target> {
    const target = await targetOf(sessionKey);
    if (!target?.guildId || !deps.botConfig()?.groups?.[target.guildId]) throw new Error("server is not allowed");
    const info = await channelInfo(target.channelId);
    if (info?.guildId !== target.guildId) throw new Error("channel does not belong to this server");
    return target;
  }

  async function openThread(sessionKey: string, name: string, text: string, persistent = false) {
    const target = await serverTarget(sessionKey);
    return createThread(target.channelId, { name, message: text, persistent });
  }

  async function prompt(sessionKey: string, text: string) {
    const target = await serverTarget(sessionKey);
    const current = deps.gateway.threads.current(sessionKey);
    if (current?.archiveRequested) deps.gateway.threads.update(current.id, { archiveRequested: false });
    await maintainGroupRegistry(target.guildId!, target.channelId);
    void conversations.runTurn(target, text, []).catch((error) => log.error(`remote turn in ${sessionKey} failed: ${error}`));
  }

  async function archive(sessionKey: string) {
    const target = await serverTarget(sessionKey);
    if (!THREADS.has(channels.get(target.channelId)!.type)) throw new Error("only threads can be archived");
    const thread = deps.gateway.threads.current(sessionKey);
    if (thread && !thread.archiveRequested) deps.gateway.threads.update(thread.id, { archiveRequested: true });
    if (thread && (deps.gateway.isThreadRunning(thread.id) || deps.gateway.hasPendingReply(sessionKey))) return;
    await rest.request("PATCH", `/channels/${target.channelId}`, { body: { archived: true } });
    if (thread) deps.gateway.threads.update(thread.id, { persistent: false, archiveRequested: false });
  }

  async function flushArchives() {
    for (const thread of deps.gateway.threads.list()) {
      if (!thread.archiveRequested || !deps.gateway.threads.isCurrent(thread.id) || parseDiscordSessionKey(thread.sessionKey)?.channel !== name) continue;
      await archive(thread.sessionKey).catch((error) => log.warn(`archive remains pending in ${thread.sessionKey}: ${error}`));
    }
  }

  async function dmChannel(userId: string): Promise<string> {
    const known = dmChannels.get(userId);
    if (known) return known;
    const channel = await rest.request<APIChannel>("POST", "/users/@me/channels", { body: { recipient_id: userId } });
    dmChannels.set(userId, channel.id);
    return channel.id;
  }

  async function send(sessionKey: string, markdown: string, options?: ReplyOptions) {
    const target = await targetOf(sessionKey);
    if (!target) throw new Error("thread has no Discord delivery target");
    await sendMessage(rest, target.channelId, markdown, options);
  }

  async function welcome(request: PairingRequest) {
    if (request.kind === "dm") {
      await sendMessage(rest, await dmChannel(request.userId), "✅ Pairing approved — you're in. Say hi!");
    } else if (request.origin) {
      await sendMessage(rest, request.origin, "✅ This server is now connected.");
    }
  }

  /** A person's avatar or a server's icon, small. `hash` saves the lookup when
   *  the caller already holds it. */
  async function picture(kind: "user" | "guild", id: string, hash?: string | null): Promise<Buffer | undefined> {
    try {
      if (hash === undefined) {
        hash = kind === "guild"
          ? (guilds.get(id)?.icon ?? (await rest.get<APIGuild>(`/guilds/${id}`)).icon)
          : (await rest.get<APIUser>(`/users/${id}`)).avatar;
      }
      if (!hash) return undefined;
      const response = await fetch(`${CDN}/${kind === "guild" ? "icons" : "avatars"}/${id}/${hash}.png?size=128`);
      if (!response.ok) throw new Error(`picture download failed: ${response.status}`);
      return capped(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      log.debug(`picture unavailable for ${kind} ${id}: ${error}`);
      return undefined;
    }
  }

  async function stop() {
    listening();
    conversations.stop();
    clearInterval(archiveTimer);
    clearInterval(watermarkTimer);
    gateway.stop();
  }

  return handle;
}

/** Whether a server message is talking to the bot: a mention of it or of the
 *  role Discord made for it, or a reply to one of its messages. */
export function addressesBot(
  message: Pick<APIMessage, "mentions" | "mention_roles" | "referenced_message">,
  selfId: string,
  ownRoles: ReadonlySet<string>,
): boolean {
  return message.mentions.some((user) => user.id === selfId)
    || message.mention_roles.some((role) => ownRoles.has(role))
    || message.referenced_message?.author.id === selfId;
}

function displayName(user: Pick<APIUser, "global_name" | "username">): string {
  return foldDisplayName(user.global_name ?? user.username).name;
}

function senderLabel(user: APIUser): string {
  const name = sanitizeContextLabel(displayName(user));
  const username = sanitizeContextLabel(user.username);
  return name && name !== username ? `${name} @${username}` : `@${username}`;
}

/** Compact per-message attribution for shared channels: who said it, and what
 * it answers. A DM needs neither. */
export function formatDiscordInboundPrompt(message: Pick<APIMessage, "author" | "referenced_message"> & { guild_id?: string }, body: string, selfId: string): string {
  if (!message.guild_id) return body;
  const lines = [`[${senderLabel(message.author)}]`];
  const replied = message.referenced_message;
  if (replied) {
    const toSelf = replied.author.id === selfId;
    const who = toSelf ? "you" : senderLabel(replied.author);
    lines.push(replied.content.trim()
      ? `[Replying to ${who}: ${JSON.stringify(compactReplyQuote(replied.content))}]`
      : toSelf ? "[Replying to your message]" : `[Replying to a message from ${who}]`);
  }
  return `${lines.join("\n")}\n${body}`;
}

/** Without a landed acknowledgment there is no "thinking…" slot to fill, so the answer goes to the channel. */
export async function answerCommand(
  rest: DiscordRest,
  channelId: string,
  interaction: Pick<APIInteraction, "application_id" | "token">,
  acknowledged: boolean,
  markdown: string,
) {
  if (!acknowledged) {
    await sendMessage(rest, channelId, markdown);
    return;
  }
  const [first, ...more] = discordChunks(markdown);
  const flags = MessageFlags.SuppressEmbeds;
  const webhook = `/webhooks/${interaction.application_id}/${interaction.token}`;
  await rest.request("PATCH", `${webhook}/messages/@original`, { body: { content: first ?? "Done.", flags } });
  for (const content of more) {
    await rest.request("POST", webhook, { body: { content, flags }, creates: true });
  }
}

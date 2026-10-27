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
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChannelConfig } from "../../config.ts";
import { formatInboundBody } from "../../media-store.ts";
import { logger } from "../../log.ts";
import { keyedLane, lruTouch } from "../../util.ts";
import { capped } from "../avatars.ts";
import type { BotDeps } from "../bots.ts";
import type { ChannelDestination, CreatedConversation } from "../index.ts";
import { Bursts } from "../burst.ts";
import { COMMANDS, runCommand } from "../commands.ts";
import { continuePrompt, FAILOVER_PREFIX, FailoverOffers } from "../failover.ts";
import type { PairingRequest } from "../pairing.ts";
import { topicChain } from "../session-key.ts";
import { compactReplyQuote, createSeenMessages, foldDisplayName, sanitizeContextLabel } from "../text.ts";
import { runChatTurn, WAKE_PROMPT, type TurnRetry } from "../turn.ts";
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
const MAX_CHAT_TOOLS = 128;
// The heartbeat runs every ~41 s; two missed acks is a dead connection.
const HEALTHY_ACK_MS = 100_000;
const CDN = "https://cdn.discordapp.com";

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

export interface BotHandle {
  name: string;
  username?: string;
  connected(): boolean;
  /** Re-prompt a conversation (by session key) that a restart interrupted. */
  wake(sessionKey: string): Promise<void>;
  /** Drop a conversation's buffered input before it becomes a turn. */
  discardBurst(sessionKey: string): boolean;
  /** Deliver literal text to a conversation, by session key. */
  send(sessionKey: string, markdown: string): Promise<void>;
  openThread(sessionKey: string, name: string, text: string, persistent?: boolean): Promise<CreatedConversation>;
  prompt(sessionKey: string, text: string): Promise<void>;
  archive(sessionKey: string): Promise<void>;
  destinations(): Promise<ChannelDestination[]>;
  describe(sessionKey: string): Promise<ChannelDestination>;
  welcome(request: PairingRequest): Promise<void>;
  /** The picture of a person (DM) or a server, as stored bytes. */
  picture(kind: "user" | "guild", id: string): Promise<Buffer | undefined>;
  stop(): Promise<void>;
}

export function startDiscordBot(name: string, token: string, deps: BotDeps): BotHandle {
  const log = logger(`discord/${name}`);
  const rest = new DiscordRest(token);
  const gateway = new DiscordGateway(token, INTENTS, log);
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
    wake,
    discardBurst,
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

  // One tool instance per conversation — the runner only reuses a warm agent
  // session when the tools are the same objects across turns. `sent` collects
  // tool-sent texts; the owning turn clears it when it ends.
  const chatTools = new Map<string, { tool: ToolDefinition; sent: Set<string> }>();
  const toolFor = (key: string, channelId: string) => {
    let entry = lruTouch(chatTools, key);
    if (!entry) {
      const sent = new Set<string>();
      entry = { tool: discordTool(rest, channelId, (text) => sent.add(text), async (request) => {
        const created = await createThread(channelId, request);
        if (created.warning) return `Thread created: ${created.url}. NOT started: ${created.warning}. Do not create it again.`;
        return `Thread created: ${created.url}\nsession_key: ${created.sessionKey}\n${request.start ? "Agent started independently; answers will arrive in that thread and will not come back to this conversation." : "Opening context recorded; waiting for a user message."}`;
      }), sent };
      chatTools.set(key, entry);
      if (chatTools.size > MAX_CHAT_TOOLS) chatTools.delete(chatTools.keys().next().value!);
    }
    return entry;
  };

  const bursts = new Bursts<Target>((target, text, images) => void runTurn(target, text, images));
  // Per-conversation ordering of message *preparation* (downloads,
  // transcription); turns run outside it, so a message landing mid-turn still
  // reaches the runner and steers.
  const lanes = new Map<string, Promise<unknown>>();
  const failovers = new FailoverOffers<{ target: Target; text: string; images: ImageContent[] }>();
  const alreadyHandled = createSeenMessages();
  const archiveTimer = setInterval(() => void flushArchives(), 60_000);
  archiveTimer.unref();

  function discardBurst(sessionKey: string): boolean {
    return bursts.discard(sessionKey);
  }

  gateway.on("ready", (ready) => {
    self = ready.user;
    log.info(`@${self.username} connected`);
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
        return rememberGuild(payload.d);
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
        void runTurn(target, "[Task delegated from another conversation]\nCarry out the task in the opening message above. Work only on this subject; ask any necessary questions here.", [])
          .catch((error) => log.error(`delegated turn in ${sessionKey} failed: ${error}`));
      }
      return created;
    } catch (error) {
      return { ...created, warning: `setup failed: ${error}` };
    }
  }

  async function handleMessage(message: GatewayMessageCreateDispatchData) {
    const config = deps.botConfig();
    // Bots (this one included) and webhooks never start turns: two agents
    // answering each other in a channel is a loop nobody stops.
    if (!config || !self || message.author.bot || message.webhook_id) return;
    if (alreadyHandled(message.channel_id, message.id)) return;
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
    if (config.users?.[author.id]) {
      const display = displayName(author);
      deps.updateUser(author.id, (user) => {
        let changed = false;
        if (display && user.name !== display) {
          user.name = display;
          changed = true;
        }
        if (user.username !== author.username) {
          user.username = author.username;
          changed = true;
        }
        return changed;
      });
    }

    const key = sessionKeyFor(target);
    const text = readableContent(message);
    // The slash commands are interactions; these are the same typed as text.
    const command = text.match(/^\/(\w+)\s*$/)?.[1];
    const answerCommand = async () => {
      const answer = command && (await runCommand(command, commandContext(key)));
      if (!answer) return false;
      await sendMessage(rest, message.channel_id, answer, { replyTo: message.id }).catch((error) => log.warn(`command reply failed: ${error}`));
      return true;
    };
    // /stop bypasses the preparation lane: it must reach the gateway without
    // waiting behind a slow transcription.
    if (command === "stop") return void (await answerCommand());

    const release = bursts.prepare(key);
    try {
      await keyedLane(lanes, key, async () => {
        if (await answerCommand()) return;
        const media = await collectInboundMedia(message.attachments, deps.transcribeCommand());
        const body = formatInboundBody(text, media);
        if (!body.trim() && !media.images.length) return;
        // Ack now — the burst window delays the turn, not the receipt.
        void rest.request("PUT", `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(ACK_REACTION)}/@me`).catch(() => {});
        bursts.enqueue(key, target, formatDiscordInboundPrompt(message, body, self!.id), media.images);
      });
    } finally {
      release();
    }
  }

  function commandContext(sessionKey: string) {
    return { gateway: deps.gateway, sessionKey, workspace: deps.workspace(), discardBurst: () => discardBurst(sessionKey), log };
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

  /** Sender-level access: is this person allowed here at all? (mention gating is separate) */
  function senderAccess(userId: string, guildId: string | undefined, config: ChannelConfig): "ok" | "pair" | "ignore" {
    if (!guildId) return config.users?.[userId] ? "ok" : "pair";
    // Unregistered server → surface a pairing request instead of silence.
    if (!config.groups?.[guildId]) return "pair";
    const allowed = (config.groupAllowedUsers ?? Object.keys(config.users ?? {})).map(String);
    return allowed.includes(userId) ? "ok" : "ignore";
  }

  function checkAccess(message: GatewayMessageCreateDispatchData, config: ChannelConfig): "ok" | "pair" | "ignore" {
    const access = senderAccess(message.author.id, message.guild_id, config);
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
    const kind = guildId ? "group" : "dm";
    const chatId = guildId ?? author.id;
    // Checking for a pending request first keeps a persistent knocker from
    // costing a picture download per message.
    if (deps.pairing.find({ bot: name, kind, userId: author.id, chatId })) return;
    const { name: senderName, disguised } = foldDisplayName(author.global_name ?? author.username);
    const photo = guildId ? await picture("guild", guildId) : await picture("user", author.id, author.avatar);
    const { request, isNew } = deps.pairing.request({
      kind,
      bot: name,
      userId: author.id,
      chatId,
      chatTitle: guildId ? guilds.get(guildId)?.name : undefined,
      origin: guildId ? message.channel_id : undefined,
      username: author.username,
      name: senderName,
      disguised: disguised || undefined,
      photo: photo && `data:image/png;base64,${photo.toString("base64")}`,
    });
    if (!isNew) return; // already pending; stay quiet instead of spamming
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
    const respond = (body: unknown) => rest.request("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { body });

    // Same access policy as messages, minus the mention gate (a command or a
    // press is explicit).
    if (senderAccess(user.id, guildId, config) !== "ok") {
      await respond({ type: InteractionResponseType.ChannelMessageWithSource, data: { content: "This bot is private.", flags: MessageFlags.Ephemeral } });
      return;
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
      const sessionKey = sessionKeyFor(target);
      log.info(`command /${interaction.data.name} in ${sessionKey}`);
      // Answer within Discord's three seconds, then take the time the command
      // needs (/usage asks every provider).
      await respond({ type: InteractionResponseType.DeferredChannelMessageWithSource });
      const answer = (await runCommand(interaction.data.name, commandContext(sessionKey))) ?? "Unknown command.";
      await followUp(interaction.application_id, interaction.token, answer);
      return;
    }

    if (interaction.type === InteractionType.MessageComponent) {
      const data = interaction.data.custom_id;
      if (data === STOP_BUTTON_ID) {
        // The card redraws itself as stopped once the turn winds down; the
        // press only needs acknowledging.
        await respond({ type: InteractionResponseType.DeferredMessageUpdate });
        const sessionKey = sessionKeyFor(target);
        log.info(`stop pressed in ${sessionKey}`);
        discardBurst(sessionKey);
        await deps.gateway.interrupt(sessionKey);
        return;
      }
      // A pressed row has done its job: grey it out so the same action can't
      // be fired twice (and so the chat records which option was taken). This
      // is also the answer Discord waits for.
      await respond({ type: InteractionResponseType.UpdateMessage, data: { components: disableComponents(interaction.message.components, data) } });
      if (data.startsWith(FAILOVER_PREFIX)) return retryOnFallback(data, target);
      // The marker on a line of its own is the dashboard's press prompt too, and
      // what lets the transcript draw it as a caption instead of as prose.
      void runTurn(target, `[inline button pressed]\n${data}`, []);
    }
  }

  /** The deferred answer to a slash command: the first piece replaces Discord's
   *  "thinking…", the rest follow it. */
  async function followUp(applicationId: string, interactionToken: string, markdown: string) {
    const [first, ...more] = discordChunks(markdown);
    const flags = MessageFlags.SuppressEmbeds;
    await rest.request("PATCH", `/webhooks/${applicationId}/${interactionToken}/messages/@original`, { body: { content: first ?? "Done.", flags } });
    for (const content of more) {
      await rest.request("POST", `/webhooks/${applicationId}/${interactionToken}`, { body: { content, flags }, creates: true });
    }
  }

  /** The person took one of the two ways out a failed turn offered: pick the
   * dead turn up where it stopped, or run the original request from nothing —
   * both on the models its plan never reached. */
  function retryOnFallback(data: string, target: Target) {
    const sessionKey = sessionKeyFor(target);
    const offer = failovers.take(data, sessionKey);
    if (!offer) {
      void sendMessage(rest, target.channelId, "⚠️ That retry is no longer on the table — send the message again.").catch(() => {});
      return;
    }
    const { replay, models, mode } = offer;
    log.info(`manual failover in ${sessionKey}: ${mode} on ${models[0]!.model}`);
    const restart = mode === "restart";
    void runTurn(replay.target, restart ? replay.text : continuePrompt(offer.hiddenToolCalls), restart ? replay.images : [], {
      models,
      // A continue keeps the failed attempt: its tool calls are what the next
      // model resumes from. Only a restart branches them away.
      rewind: restart ? offer.rewind : undefined,
    });
  }

  /** `retry` is set by a manual failover: its own model plan for this turn
   * alone, and the failed attempt a restart branches away first. */
  async function runTurn(target: Target, text: string, images: ImageContent[], retry?: TurnRetry) {
    const sessionKey = sessionKeyFor(target);
    const { channelId } = target;
    const { tool, sent } = toolFor(sessionKey, channelId);

    // Whatever owns this conversation: the person in a DM, the server in a
    // server — where each channel and thread is a topic of its own.
    const config = deps.botConfig();
    const owner = target.guildId ? config?.groups?.[target.guildId] : config?.users?.[target.userId!];
    // A thread sits in a channel, a channel in a category: innermost first.
    const topics = target.guildId ? topicChain(owner, channelId) : [];
    // Appends accumulate outermost→innermost: the owner's, then each topic's.
    const appends = [owner, ...[...topics].reverse()].map((scope) => scope?.appendSystemPrompt).filter((a): a is string => !!a);
    const autoRetry = await runChatTurn({
      gateway: deps.gateway,
      sessionKey,
      text,
      images,
      retry,
      incoming: {
        workspaceHint: deps.workspace(),
        // Most specific first: a thread's model settings beat its channel's,
        // which beat its category's and its server's.
        modelScopes: [...topics, owner],
        appends,
        customTools: [tool],
        runtime: {
          channel: "discord",
          conversation: describeConversation(target, config),
          capabilities: [
            "Discord markdown (headings up to ###, lists, code blocks, ||spoilers||; tables arrive as monospace blocks)",
            "buttons",
            "files",
            "reactions — via the discord tool",
          ],
        },
      },
      sent,
      status: new DiscordTurnStatus(rest, channelId, target.triggerMessageId),
      send: (markdown, options) => sendMessage(rest, channelId, markdown, {
        replyTo: options.reply ? target.triggerMessageId : undefined,
        buttons: options.buttons,
        silent: options.silent,
      }),
      failovers,
      replay: { target, text, images },
      autoFailover: deps.autoFailover,
      log,
    });
    // A turn of its own, with its own status message and its own failure
    // handling (including, if it comes to it, the next failover — the plan it
    // carries is strictly shorter, so the chain ends).
    if (autoRetry) await runTurn(target, autoRetry.text, [], { models: autoRetry.models });
    else if (deps.gateway.threads.current(sessionKey)?.archiveRequested) {
      await archive(sessionKey).catch((error) => log.warn(`archive remains pending in ${sessionKey}: ${error}`));
    }
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
    void runTurn(target, text, []).catch((error) => log.error(`remote turn in ${sessionKey} failed: ${error}`));
  }

  async function archive(sessionKey: string) {
    const target = await serverTarget(sessionKey);
    if (!THREADS.has(channels.get(target.channelId)!.type)) throw new Error("only threads can be archived");
    const thread = deps.gateway.threads.current(sessionKey);
    if (thread && !thread.archiveRequested) deps.gateway.threads.update(thread.id, { archiveRequested: true });
    if (thread && deps.gateway.isThreadRunning(thread.id)) return;
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

  /** Resume a conversation a restart cut off. */
  async function wake(sessionKey: string) {
    const target = await targetOf(sessionKey).catch((error) => (log.warn(`cannot wake ${sessionKey}: ${error}`), undefined));
    if (!target) {
      log.warn(`cannot wake ${sessionKey}: unrecognized session key`);
      return;
    }
    log.info(`waking interrupted turn in ${sessionKey}`);
    await runTurn(target, WAKE_PROMPT, []);
  }

  async function send(sessionKey: string, markdown: string) {
    const target = await targetOf(sessionKey);
    if (!target) throw new Error("thread has no Discord delivery target");
    await sendMessage(rest, target.channelId, markdown);
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
    bursts.flushAll();
    clearInterval(archiveTimer);
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

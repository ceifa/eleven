import { API_CONSTANTS, Bot, type Context } from "grammy";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { ChannelConfig, GroupConfig, TopicConfig, UserConfig } from "../../config.ts";
import { lruTouch } from "../../util.ts";
import type { Gateway } from "../../gateway.ts";
import type { PairingStore } from "../pairing.ts";
import { Bursts } from "../burst.ts";
import { COMMANDS, runCommand } from "../commands.ts";
import { continuePrompt, FAILOVER_PREFIX, FailoverOffers, type ChatButton } from "../failover.ts";
import { compactReplyQuote, createSeenMessages, foldDisplayName, sanitizeContextLabel } from "../text.ts";
import { runChatTurn, WAKE_PROMPT, type TurnRetry } from "../turn.ts";
import { collectInboundMedia, formatInboundBody } from "./media.ts";
import { parseTelegramSessionKey } from "./session-key.ts";
import { TelegramTurnStatus } from "./turn-status.ts";
import { sendRich } from "./rich.ts";
import { chatPhoto } from "./avatars.ts";
import { isNoop, withRetry } from "./retry.ts";
import { disableKeyboard, telegramTool } from "./tool.ts";
import { logger } from "../../log.ts";

const STALL_THRESHOLD_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 30_000;
const RESTART_BACKOFF_MS = { initial: 30_000, max: 600_000 };
const ACK_REACTION = "👀";
const MAX_CHAT_TOOLS = 128;
// Telegram flood-limits a group at roughly twenty messages a minute, counting
// edits — one call every three seconds is the sustained rate that fits.
const GROUP_MIN_INTERVAL_MS = 3_000;

/** Where a turn should land, distilled from a live update or a bare session key
 * (a wake-up after restart has no grammy Context to read from). */
interface Target {
  chatId: number;
  topic?: number;
  isPrivate: boolean;
  /** Sender whose per-user append applies (DMs). */
  userId?: number;
  /** Message to ack/reply to, when a specific one triggered the turn. */
  triggerMessageId?: number;
}

/** Keep one canonical command list. Telegram gives group-specific scopes
 * precedence over the default scope, so a bot token that served another gateway
 * before can still carry that gateway's all_group_chats list. */
export async function syncTelegramCommands(
  api: Pick<Bot["api"], "setMyCommands" | "deleteMyCommands">,
): Promise<void> {
  await api.setMyCommands([...COMMANDS]);
  await api.deleteMyCommands({ scope: { type: "all_group_chats" } });
}

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
  updateGroup: (chatId: string, mutate: (group: GroupConfig) => boolean) => void;
  /** Mutate an allowed user's config entry; return true to persist. */
  updateUser: (userId: string, mutate: (user: UserConfig) => boolean) => void;
}

export interface BotHandle {
  bot: Bot;
  name: string;
  username?: string;
  lastPollAt: number;
  /** Re-prompt a conversation (by session key) that a restart interrupted. */
  wake(sessionKey: string): Promise<void>;
  /** Drop a conversation's buffered input before it becomes a turn (a stop
   *  issued from outside Telegram — the dashboard — needs this too). */
  discardBurst(sessionKey: string): boolean;
  stop(): Promise<void>;
}

export function startTelegramBot(name: string, token: string, deps: BotDeps): BotHandle {
  const log = logger(`telegram/${name}`);
  const bot = new Bot(token);
  const handle: BotHandle = { bot, name, lastPollAt: Date.now(), wake, discardBurst, stop };

  const sessionKeyFor = (chatId: number, topic?: number) =>
    `telegram:${name}:${chatId}${topic !== undefined ? `:topic:${topic}` : ""}`;

  // One tool instance per conversation — the runner only reuses a warm agent
  // session when the tools are the same objects across turns. `sent` collects
  // tool-sent texts; the owning turn clears it when it ends.
  const chatTools = new Map<string, { tool: ToolDefinition; sent: Set<string> }>();
  const toolFor = (chatId: number, topic?: number) => {
    const key = sessionKeyFor(chatId, topic);
    let entry = lruTouch(chatTools, key);
    if (!entry) {
      const sent = new Set<string>();
      entry = { tool: telegramTool(bot.api, chatId, topic, (text) => sent.add(text)), sent };
      chatTools.set(key, entry);
      if (chatTools.size > MAX_CHAT_TOOLS) chatTools.delete(chatTools.keys().next().value!);
    }
    return entry;
  };

  const bursts = new Bursts<Target>((target, text, images) => void runTurn(target, text, images));

  /** Drop a conversation's pending burst (/stop and /new discard queued input). */
  function discardBurst(sessionKey: string): boolean {
    return bursts.discard(sessionKey);
  }

  // Manual failover buttons hanging off failure messages, each holding what it
  // takes to run that turn again.
  const failovers = new FailoverOffers<{ target: Target; text: string; images: ImageContent[] }>();

  const alreadyHandled = createSeenMessages();

  // The default group bucket (20 per minute, one per second) hands out its whole
  // minute in the first twenty seconds — and Telegram's flood control reads a
  // sliding window, so that burst is exactly what earns a 429. Space them out at
  // the rate the limit actually allows instead.
  bot.api.config.use(apiThrottler({ group: { maxConcurrent: 1, minTime: GROUP_MIN_INTERVAL_MS } }));
  // Watchdog heartbeat: note every completed getUpdates round-trip.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === "getUpdates") handle.lastPollAt = Date.now();
    return result;
  });

  bot.catch((error) => log.error(`update failed: ${error.error}`));

  // Callback queries must be answered within Telegram's ~15s deadline — before
  // sequentialize can queue them behind a long agent turn.
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) void ctx.answerCallbackQuery().catch(() => {});
    await next();
  });

  // Track how many of a conversation's messages sit between arrival and the
  // end of preparation (sequentialize queue + media download/transcription) —
  // registered before sequentialize so the count covers the queued wait too.
  bot.use(async (ctx, next) => {
    const release = ctx.message ? bursts.prepare(sessionKeyFor(ctx.chat!.id, topicOf(ctx.message))) : undefined;
    try {
      await next();
    } finally {
      release?.();
    }
  });

  // Per-chat/per-topic ordering of message *preparation* only (commands, media
  // transcription) — turns run outside the lane (the burst flush), so a
  // message arriving mid-turn still reaches the runner and steers. /stop keeps
  // its escape lane to bypass even a slow preparation (e.g. a long transcription).
  bot.use(
    sequentialize((ctx) => {
      const chat = ctx.chat?.id;
      if (chat === undefined) return undefined;
      // Stops bypass the lane: /stop must reach the gateway without waiting
      // behind a slow preparation (e.g. a long transcription).
      if (ctx.message?.text?.trim().startsWith("/stop")) return `${chat}:control`;
      const topic = topicOf(ctx.message);
      return topic !== undefined ? `${chat}:topic:${topic}` : String(chat);
    }),
  );

  bot.on("message", (ctx) => handleMessage(ctx));
  bot.on("callback_query:data", (ctx) => handleCallback(ctx));

  async function handleMessage(ctx: Context) {
    const message = ctx.message;
    const config = deps.botConfig();
    if (!message || !config || !message.from || message.from.is_bot) return;
    if (alreadyHandled(ctx.chat!.id, message.message_id)) return;

    if (ctx.chat!.type !== "private") maintainGroupRegistry(ctx, config);

    const access = checkAccess(ctx, config);
    if (access === "pair") return offerPairing(ctx);
    if (access === "ignore") return;

    // Names self-heal from traffic, like group titles.
    if (config.users?.[String(message.from.id)]) {
      const { id, username } = message.from;
      const name = fullName(message.from);
      const topic = userTopicEntry(ctx.chat!.type, message);
      deps.updateUser(String(id), (user) => {
        let changed = false;
        if (name && user.name !== name) {
          user.name = name;
          changed = true;
        }
        if (username && user.username !== username) {
          user.username = username;
          changed = true;
        }
        // A bot with topic mode enabled has topics in its DMs too, and they
        // register themselves the same way a forum's do.
        return registerTopic(user, topic) || changed;
      });
    }

    const text = message.text ?? message.caption ?? "";
    if (text.trim().startsWith("/") && (await handleCommand(ctx, text.trim()))) return;

    const media = await collectInboundMedia(ctx, token, deps.transcribeCommand());
    const body = formatInboundBody(text, media);
    if (!body.trim() && !media.images.length) return;
    // Attribute the complete body, not just text/captions: voice transcripts and
    // media-only messages need the same sender context as ordinary text.
    const prompt = formatTelegramInboundPrompt(ctx, body);

    const target = targetFromContext(ctx);
    // Ack now — the burst window delays the turn, not the receipt.
    if (target.triggerMessageId !== undefined) {
      void bot.api.setMessageReaction(target.chatId, target.triggerMessageId, [{ type: "emoji", emoji: ACK_REACTION }]).catch(() => {});
    }
    bursts.enqueue(sessionKeyFor(target.chatId, target.topic), target, prompt, media.images);
  }

  async function handleCallback(ctx: Context) {
    const config = deps.botConfig();
    const from = ctx.callbackQuery?.from;
    if (!config || !from || !ctx.chat) return;
    // Same access policy as messages, minus the mention gate (a button press is explicit).
    if (senderAccess(ctx.chat, from.id, config) !== "ok") return;
    // A pressed keyboard has done its job: grey it out so the same action can't
    // be fired twice (and so the chat records which option was taken).
    void disablePressedKeyboard(ctx).catch((error) => log.warn(`disabling keyboard failed: ${error}`));
    const data = ctx.callbackQuery!.data ?? "";
    const target = targetFromContext(ctx);
    // Fire-and-forget: holding the prep lane for the whole turn would block
    // (and un-steer) every message behind it.
    if (data.startsWith(FAILOVER_PREFIX)) return void retryOnFallback(data, target);
    // The marker on a line of its own is the dashboard's press prompt too, and
    // what lets the transcript draw it as a caption instead of as prose.
    void runTurn(target, `[inline button pressed]\n${data}`, []);
  }

  /** The person took one of the two ways out a failed turn offered: pick the
   * dead turn up where it stopped, or run the original request from nothing —
   * both on the models its plan never reached. */
  function retryOnFallback(callbackData: string, target: Target) {
    const sessionKey = sessionKeyFor(target.chatId, target.topic);
    const offer = failovers.take(callbackData, sessionKey);
    if (!offer) {
      void sendRich(bot.api, target.chatId, "⚠️ That retry is no longer on the table — send the message again.", {
        messageThreadId: target.topic,
      }).catch(() => {});
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

  /** Grey out the pressed message's keyboard so the action can't be repeated. */
  async function disablePressedKeyboard(ctx: Context) {
    const message = ctx.callbackQuery?.message;
    if (!message || !("reply_markup" in message)) return;
    const rows = message.reply_markup?.inline_keyboard;
    if (!rows?.length) return;
    try {
      await withRetry("idempotent", "disable keyboard", () =>
        ctx.api.raw.editMessageReplyMarkup({
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: { inline_keyboard: disableKeyboard(rows, ctx.callbackQuery!.data) },
        }),
      );
    } catch (error) {
      if (!isNoop(error)) throw error;
    }
  }

  /** `retry` is set by a manual failover: its own model plan for this turn
   * alone, and the failed attempt a restart branches away first. */
  async function runTurn(target: Target, text: string, images: ImageContent[], retry?: TurnRetry) {
    const { chatId, topic, isPrivate } = target;
    const sessionKey = sessionKeyFor(chatId, topic);
    void bot.api.sendChatAction(chatId, "typing", { message_thread_id: topic }).catch(() => {});

    const { tool, sent } = toolFor(chatId, topic);
    const replyParameters = target.triggerMessageId !== undefined
      ? { message_id: target.triggerMessageId, allow_sending_without_reply: true }
      : undefined;

    // Whatever owns this conversation: the person in a DM, the group in a group.
    // Both carry topics — a bot with topic mode enabled has them in its DMs too
    // — so the scope chain is the same shape on both sides. (In a private chat
    // the chat id is the user id, which is what wake() reconstructs from.)
    const config = deps.botConfig();
    const owner = isPrivate ? config?.users?.[String(chatId)] : config?.groups?.[String(chatId)];
    const topicConfig = topic !== undefined ? owner?.topics?.[String(topic)] : undefined;
    // Appends accumulate outermost→innermost: the owner's, then the topic's.
    const appends = [owner?.appendSystemPrompt, topicConfig?.appendSystemPrompt].filter((a): a is string => !!a);
    const autoRetry = await runChatTurn({
      gateway: deps.gateway,
      sessionKey,
      text,
      images,
      retry,
      incoming: {
        workspaceHint: deps.workspace(),
        // Most specific first: a topic's model settings beat its owner's.
        modelScopes: [topicConfig, owner],
        appends,
        customTools: [tool],
        runtime: {
          channel: "telegram",
          conversation: describeConversation(target, config),
          capabilities: ["rich markdown (headings/tables/spoilers render natively)", "inline buttons", "media files", "reactions — via the telegram tool"],
        },
      },
      sent,
      status: new TelegramTurnStatus(bot.api, chatId, { topic, replyParameters }),
      send: (markdown, options) => sendRich(bot.api, chatId, markdown, {
        messageThreadId: topic,
        replyParameters: options.reply ? replyParameters : undefined,
        replyMarkup: inlineKeyboard(options.buttons),
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
  }

  /** Resume a conversation a restart cut off — reconstruct the target from the
   * session key alone (no live update to read) and re-prompt the agent. */
  async function wake(sessionKey: string) {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target || target.channel !== name) {
      log.warn(`cannot wake ${sessionKey}: unrecognized session key`);
      return;
    }
    const { chatId, topic } = target;
    // Telegram private-chat ids equal the user id and are positive; groups/channels are negative.
    const isPrivate = chatId > 0;
    log.info(`waking interrupted turn in ${sessionKey}`);
    await runTurn(
      { chatId, topic, isPrivate, userId: isPrivate ? chatId : undefined },
      WAKE_PROMPT,
      [],
    );
  }

  async function handleCommand(ctx: Context, text: string): Promise<boolean> {
    const chat = ctx.chat!;
    const topic = topicOf(ctx.message);
    const sessionKey = sessionKeyFor(chat.id, topic);
    const [command] = text.split(/\s+/);
    // Commands are rare and act on a session the user can't see; when one seems
    // to do nothing, this line is the only record of which session it hit.
    log.info(`command ${command} in ${sessionKey} (message ${ctx.message?.message_id}, thread ${ctx.message?.message_thread_id ?? "-"}, topic message ${ctx.message?.is_topic_message ?? false})`);
    // Answer *on* the command. Beyond being easier to follow in a busy group,
    // a reply is what pins the answer to the same forum topic even when the
    // command arrived without the flags topicOf needs to recognize one.
    const replyParameters = ctx.message?.message_id
      ? { message_id: ctx.message.message_id, allow_sending_without_reply: true }
      : undefined;
    const reply = (markdown: string) =>
      sendRich(ctx.api, chat.id, markdown, { messageThreadId: topic, replyParameters }).then(() => true);

    const bare = command.replace(`@${handle.username}`, "");
    if (bare === "/start") return reply(`Hi! I'm **${name}** running on eleven.\nYour user id: \`${ctx.from?.id}\``);
    const answer = await runCommand(bare.slice(1), {
      gateway: deps.gateway,
      sessionKey,
      workspace: deps.workspace(),
      discardBurst: () => discardBurst(sessionKey),
      log,
    });
    // An unknown command goes to the agent as text.
    return answer === undefined ? false : reply(answer);
  }

  /** Keep the config registry in sync with live traffic: group titles heal on
   * any message; forum topics register themselves (with their name) when they
   * first speak. Saves only when something actually changed. */
  function maintainGroupRegistry(ctx: Context, config: ChannelConfig) {
    const message = ctx.message!;
    const chatId = String(ctx.chat!.id);
    if (!config.groups?.[chatId]) return; // unregistered → the pairing path owns it

    const chatTitle = (ctx.chat as { title?: string }).title;
    const topic = topicEntry(message);

    deps.updateGroup(chatId, (group) => {
      let changed = false;
      if (chatTitle && group.title !== chatTitle) {
        group.title = chatTitle;
        changed = true;
      }
      return registerTopic(group, topic) || changed;
    });
  }

  async function offerPairing(ctx: Context) {
    const from = ctx.from!;
    const chat = ctx.chat!;
    const isGroup = chat.type !== "private";
    const kind = isGroup ? "group" : "dm";
    // Deciding on a stranger goes better with a face, so the request carries
    // one. Checking for a pending request first keeps a persistent knocker from
    // costing a download per message — and fetching before registering keeps
    // the photo in the request the dashboard is pushed.
    const userId = String(from.id);
    const chatId = String(chat.id);
    if (deps.pairing.find({ bot: name, kind, userId, chatId })) return;
    const raw = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const { name: senderName, disguised } = foldDisplayName(raw);
    const { request, isNew } = deps.pairing.request({
      kind,
      bot: name,
      userId,
      chatId,
      chatTitle: isGroup ? (chat as { title?: string }).title : undefined,
      username: from.username,
      name: senderName,
      disguised: disguised || undefined,
      photo: await profilePhoto(ctx, chat.id),
    });
    if (!isNew) return; // already pending; stay quiet instead of spamming
    log.info(`pairing request (${request.kind}) from ${from.id} (@${from.username}) chat ${chat.id}`);
    if (!isGroup) {
      // Groups stay silent — the request just shows up in the dashboard.
      void sendRich(ctx.api, chat.id, "This bot is private. I've asked the owner to approve you — hang tight.").catch(() => {});
    }
  }

  /** A chat's picture (the user's, in a DM) as a data URL. Decoration on a
   *  decision that must still be made without it: any failure is a shrug. */
  async function profilePhoto(ctx: Context, chatId: number): Promise<string | undefined> {
    try {
      const buffer = await chatPhoto(ctx.api, token, chatId);
      return buffer && `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch (error) {
      log.debug(`profile photo unavailable for chat ${chatId}: ${error}`);
      return undefined;
    }
  }

  /** Chat-level access: is this sender allowed here at all? (mention gating is separate) */
  function senderAccess(chat: { type: string; id: number }, userId: number, config: ChannelConfig): "ok" | "pair" | "ignore" {
    if (chat.type === "private") {
      return config.users?.[String(userId)] ? "ok" : "pair";
    }
    // Unregistered group → surface a pairing request instead of silence.
    if (!config.groups?.[String(chat.id)]) return "pair";
    const allowed = (config.groupAllowedUsers ?? Object.keys(config.users ?? {})).map(String);
    return allowed.includes(String(userId)) ? "ok" : "ignore";
  }

  function checkAccess(ctx: Context, config: ChannelConfig): "ok" | "pair" | "ignore" {
    const access = senderAccess(ctx.chat!, ctx.message!.from!.id, config);
    if (access !== "ok" || ctx.chat!.type === "private") return access;
    const group = config.groups![String(ctx.chat!.id)];
    if (group.requireMention === false) return "ok";
    return isMention(ctx) ? "ok" : "ignore";
  }

  function isMention(ctx: Context): boolean {
    const message = ctx.message!;
    if (handle.username && (message.text ?? message.caption ?? "").toLowerCase().includes(`@${handle.username.toLowerCase()}`)) return true;
    return message.reply_to_message?.from?.username === handle.username;
  }

  function targetFromContext(ctx: Context): Target {
    const chat = ctx.chat!;
    // Callback queries carry no ctx.message — the topic lives on the message the
    // button is attached to, so a button press stays in its own forum topic.
    const message = ctx.message ?? ctx.callbackQuery?.message;
    return {
      chatId: chat.id,
      topic: topicOf(message),
      isPrivate: chat.type === "private",
      userId: ctx.from?.id,
      triggerMessageId: ctx.message?.message_id,
    };
  }

  function describeConversation(target: Target, config: ChannelConfig | undefined): string {
    const topicOwner = target.isPrivate ? config?.users?.[String(target.chatId)] : config?.groups?.[String(target.chatId)];
    const where = (() => {
      if (target.isPrivate) {
        const user = config?.users?.[String(target.chatId)];
        const name = user?.name || "user";
        return `DM with ${name}${user?.username ? ` (@${user.username})` : ""}`;
      }
      return `group "${config?.groups?.[String(target.chatId)]?.title ?? target.chatId}"`;
    })();
    if (target.topic === undefined) return where;
    const topicTitle = topicOwner?.topics?.[String(target.topic)]?.title;
    return `${where}, topic ${topicTitle ? `"${topicTitle}"` : target.topic}`;
  }

  // --- polling lifecycle: runner + stall watchdog + exponential restart backoff ---

  let stopped = false;
  let runner: RunnerHandle | undefined;

  const loop = async () => {
    let backoff = RESTART_BACKOFF_MS.initial;
    while (!stopped) {
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const me = await bot.api.getMe();
        handle.username = me.username;
        await bot.api.deleteWebhook({ drop_pending_updates: false });
        // Replace the default list and remove stale group-specific overrides.
        await syncTelegramCommands(bot.api).catch((error) => log.warn(`command sync failed: ${error}`));
        handle.lastPollAt = Date.now();
        // stop() may have fired during the awaits above, before `runner` existed
        // to be stopped — don't start a poller that nothing can shut down.
        if (stopped) return;
        runner = run(bot, {
          sink: { concurrency: 4 },
          runner: {
            fetch: { timeout: 30, allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES] },
            silent: true,
            maxRetryTime: 60 * 60 * 1000,
            retryInterval: "exponential",
          },
        });
        log.info(`@${me.username} polling`);
        watchdog = setInterval(() => {
          if (Date.now() - handle.lastPollAt > STALL_THRESHOLD_MS) {
            log.warn("polling stalled, restarting runner");
            void runner?.stop();
          }
        }, WATCHDOG_INTERVAL_MS);
        backoff = RESTART_BACKOFF_MS.initial;
        await runner.task();
        if (!stopped) log.warn("runner ended unexpectedly, restarting");
      } catch (error) {
        if (String(error).includes("409")) {
          log.error("getUpdates conflict (409): another process is polling this token — backing off");
        } else {
          log.error(`polling crashed: ${error}`);
        }
      } finally {
        clearInterval(watchdog);
      }
      if (!stopped) {
        const jitter = 1 + (Math.random() - 0.5) * 0.4;
        await new Promise((resolve) => setTimeout(resolve, backoff * jitter));
        backoff = Math.min(backoff * 2, RESTART_BACKOFF_MS.max);
      }
    }
  };
  void loop();

  async function stop() {
    stopped = true;
    bursts.flushAll();
    await runner?.stop().catch(() => {});
  }

  return handle;
}

/** Buttons as Telegram hangs them under a message. */
export function inlineKeyboard(rows?: ChatButton[][]): InlineKeyboardMarkup | undefined {
  return rows?.length ? { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) } : undefined;
}

function fullName(user?: { first_name?: string; last_name?: string }): string {
  return foldDisplayName([user?.first_name, user?.last_name].filter(Boolean).join(" ")).name;
}

interface TopicAnnouncement {
  name?: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface TopicEntry {
  id: string;
  name?: string;
  iconColor?: number;
  /** "" when the message says the topic has no emoji; absent when it says nothing. */
  iconEmojiId?: string;
  /** Read off the topic's root, which keeps the name and icon the topic was
   *  created with — true once, stale after any edit. It only fills gaps. */
  fromRoot?: boolean;
}

/** The topic a message belongs to, plus whatever name and icon Telegram let
 * slip along with it (topics announce themselves through service messages). */
export function topicEntry(message: {
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: TopicAnnouncement;
  forum_topic_edited?: TopicAnnouncement;
  reply_to_message?: unknown;
}): TopicEntry | undefined {
  const id = topicOf(message);
  if (id === undefined) return undefined;
  const root = (message.reply_to_message as { forum_topic_created?: TopicAnnouncement } | undefined)?.forum_topic_created;
  const created = message.forum_topic_created;
  const edited = message.forum_topic_edited;
  // A creation without an emoji is a statement that there is none; an edit
  // without the field left the emoji alone, and "" in it removed it.
  if (created) return { id: String(id), name: created.name, iconColor: created.icon_color, iconEmojiId: created.icon_custom_emoji_id ?? "" };
  if (edited) return { id: String(id), name: edited.name, iconEmojiId: edited.icon_custom_emoji_id };
  if (root) return { id: String(id), name: root.name, iconColor: root.icon_color, iconEmojiId: root.icon_custom_emoji_id ?? "", fromRoot: true };
  return { id: String(id) };
}

/** The topic to file under the sender's own entry. Only a DM's topics belong
 * to the person: a forum topic they speak in is the group's, and filing it
 * there too filled every DM with the topics of every group its owner talks in. */
export function userTopicEntry(chatType: string, message: Parameters<typeof topicEntry>[0]): TopicEntry | undefined {
  return chatType === "private" ? topicEntry(message) : undefined;
}

/** Register (and name) a topic under whatever owns it — a group, or the DM of
 * a bot with topic mode enabled. Returns whether the config changed. */
export function registerTopic(owner: { topics?: Record<string, TopicConfig> }, entry?: TopicEntry): boolean {
  if (!entry) return false;
  const topics = (owner.topics ??= {});
  let changed = false;
  if (!topics[entry.id]) {
    topics[entry.id] = {};
    changed = true;
  }
  const topic = topics[entry.id];
  // The root would put a renamed topic's old name back on its next message.
  if (entry.name && !(entry.fromRoot && topic.title) && topic.title !== entry.name) {
    topic.title = entry.name;
    changed = true;
  }
  // The colour is picked at creation and never edited, so any report of it is
  // current. The emoji can change, and the root would put the old one back.
  if (entry.iconColor !== undefined && topic.iconColor !== entry.iconColor) {
    topic.iconColor = entry.iconColor;
    changed = true;
  }
  const emojiKnown = topic.iconEmojiId !== undefined;
  if (entry.iconEmojiId !== undefined && !(entry.fromRoot && emojiKnown) && topic.iconEmojiId !== entry.iconEmojiId) {
    topic.iconEmojiId = entry.iconEmojiId;
    changed = true;
  }
  return changed;
}

/** A topic id, but only when the message truly belongs to a topic — a forum
 * supergroup's, or a DM's when the bot has topic mode enabled. Telegram also
 * sets message_thread_id on plain replies in non-forum supergroups, so keying a
 * session on it there would fork phantom threads and send with a thread id the
 * chat rejects; is_topic_message is the flag that tells the two apart. */
function topicOf(message: { message_thread_id?: number; is_topic_message?: boolean } | undefined): number | undefined {
  return message?.is_topic_message ? message.message_thread_id : undefined;
}

/** Compact per-message attribution for shared conversations. Message ids stay
 * in the transport layer: the gateway already replies to the triggering id,
 * and exposing them to the model would spend tokens without improving prose. */
export function formatTelegramInboundPrompt(ctx: Context, body: string): string {
  if (ctx.chat?.type === "private") return body;
  const message = ctx.message;
  const lines = [`[${senderLabel(message?.from)}]`];
  const replied = message?.reply_to_message;
  if (replied && !isTopicRoot(replied)) {
    const toSelf = replied.from?.id === ctx.me?.id;
    const repliedSender = toSelf ? "you" : senderLabel(replied.from);
    const quoted = message.quote?.text ?? replied.text ?? replied.caption;
    if (quoted?.trim()) {
      lines.push(`[Replying to ${repliedSender}: ${JSON.stringify(compactReplyQuote(quoted))}]`);
    } else {
      const kind = replyMediaKind(replied);
      lines.push(
        toSelf
          ? `[Replying to your ${kind ?? "message"}]`
          : `[Replying to ${kind ? `${kind} from` : "a message from"} ${repliedSender}]`,
      );
    }
  }
  return `${lines.join("\n")}\n${body}`;
}

/** Telegram points reply_to_message of every message in a forum topic at the
 * service message that created the topic, whether or not anyone replied. That
 * is structure, not conversation: attributing it would make the topic's creator
 * look like the person being answered. */
function isTopicRoot(replied: { forum_topic_created?: unknown }): boolean {
  return replied.forum_topic_created !== undefined;
}

function senderLabel(user?: { id?: number; first_name?: string; last_name?: string; username?: string }): string {
  const name = sanitizeContextLabel(fullName(user));
  const username = sanitizeContextLabel(user?.username ?? "");
  if (name && username) return `${name} @${username}`;
  if (name) return name;
  if (username) return `@${username}`;
  return user?.id !== undefined ? `Telegram user ${user.id}` : "Unknown sender";
}

function replyMediaKind(message: {
  photo?: unknown;
  video?: unknown;
  video_note?: unknown;
  voice?: unknown;
  audio?: unknown;
  document?: unknown;
  sticker?: unknown;
  animation?: unknown;
}): string | undefined {
  if (message.photo) return "photo";
  if (message.video) return "video";
  if (message.video_note) return "video message";
  if (message.voice) return "voice message";
  if (message.audio) return "audio";
  if (message.document) return "document";
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  return undefined;
}

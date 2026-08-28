import { API_CONSTANTS, Bot, type Context } from "grammy";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChannelConfig, GroupConfig, UserConfig } from "../../config.ts";
import { lruTouch, summarizeToolArgs } from "../../util.ts";
import type { Gateway } from "../../gateway.ts";
import type { PairingStore } from "./pairing.ts";
import { collectInboundMedia, formatInboundBody } from "./media.ts";
import { parseTelegramSessionKey } from "./session-key.ts";
import { DraftStream } from "./stream.ts";
import { TelegramTaskProgress } from "./task-progress.ts";
import { sendRich } from "./rich.ts";
import { telegramTool } from "./tool.ts";
import { logger } from "../../log.ts";

const STALL_THRESHOLD_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 30_000;
const RESTART_BACKOFF_MS = { initial: 30_000, max: 600_000 };
const ACK_REACTION = "👀";
const MAX_CHAT_TOOLS = 128;
// Coalesce rapid arrivals (forwarded batches, albums) into a single turn: each
// message re-arms the quiet window; the cap bounds the total added latency.
const BURST_QUIET_MS = 1_500;
const BURST_MAX_WAIT_MS = 5_000;
// Telegram can redeliver updates after reconnects/restarts; remember handled
// message ids long enough to swallow those instead of running double turns.
const SEEN_MESSAGE_TTL_MS = 20 * 60 * 1000;
const MAX_SEEN_MESSAGES = 5_000;

/** Injected to resume a conversation whose turn a restart cut off (see gateway
 * interruptedTurns). The pending ledger releases only after Telegram confirmed
 * the send, so waking implies the reply never landed: the model may have
 * written nothing, part of a reply, or a full one — it can see its own prior
 * output, and a finished answer must be (re)sent, not assumed delivered. */
const WAKE_PROMPT =
  "[eleven restarted mid-turn. If you already finished a reply above, it likely never reached the user — send it again. Otherwise continue from wherever you left off. No need to mention the restart unless it changes your answer]";

type InboundImage = { type: "image"; data: string; mimeType: string };

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

/** Registered with Telegram (the client's "/" menu) and handled in handleCommand. */
const COMMANDS = [
  { command: "new", description: "Start a fresh thread" },
  { command: "skills", description: "List the skills the agent can use here" },
  { command: "usage", description: "Show model subscription usage" },
  { command: "stop", description: "Abort the running turn" },
] as const;

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

  // Burst buffer: prepared messages per conversation waiting out the quiet
  // window before becoming (or steering into) one turn.
  interface Burst {
    target: Target;
    prompts: string[];
    images: InboundImage[];
    firstAt: number;
    timer: NodeJS.Timeout;
    /** Timer fired while a sibling was still preparing — flush when prep drains. */
    held?: boolean;
  }
  const bursts = new Map<string, Burst>();

  // Messages of a conversation between arrival and end of preparation. A burst
  // must not flush while this is non-zero: a fast photo would start a turn
  // without the slow audio (whisper) sent along with it.
  const preparing = new Map<string, number>();

  /** Queue a prepared message for its conversation's next turn. The flush runs
   * outside the per-chat prep lane, so a message landing mid-turn reaches the
   * runner (which steers it into the live turn) instead of waiting the whole
   * turn out behind sequentialize. */
  function enqueueTurn(target: Target, prompt: string, images: InboundImage[]) {
    const key = sessionKeyFor(target.chatId, target.topic);
    const burst = bursts.get(key);
    if (!burst) {
      bursts.set(key, {
        target,
        prompts: [prompt],
        images: [...images],
        firstAt: Date.now(),
        timer: setTimeout(() => flushBurst(key), BURST_QUIET_MS),
      });
      return;
    }
    clearTimeout(burst.timer);
    burst.prompts.push(prompt);
    burst.images.push(...images);
    burst.held = false; // fresh arrival → the quiet window runs again
    // Ack/reply threading targets the newest message that has an id.
    burst.target = { ...target, triggerMessageId: target.triggerMessageId ?? burst.target.triggerMessageId };
    const untilCap = burst.firstAt + BURST_MAX_WAIT_MS - Date.now();
    burst.timer = setTimeout(() => flushBurst(key), Math.max(0, Math.min(BURST_QUIET_MS, untilCap)));
  }

  function flushBurst(key: string) {
    const burst = bursts.get(key);
    if (!burst) return;
    if (preparing.get(key)) {
      // A sibling message is still in the prep lane (e.g. a long transcription)
      // — hold; the prep-tracking middleware re-flushes when it drains.
      burst.held = true;
      return;
    }
    bursts.delete(key);
    void runTurn(burst.target, burst.prompts.join("\n\n"), burst.images);
  }

  /** Drop a conversation's pending burst (/stop and /new discard queued input). */
  function discardBurst(sessionKey: string): boolean {
    const burst = bursts.get(sessionKey);
    if (!burst) return false;
    clearTimeout(burst.timer);
    bursts.delete(sessionKey);
    return true;
  }

  // Handled (chat, message_id) pairs — insertion-ordered so eviction drops the oldest.
  const seenMessages = new Map<string, number>();
  function alreadyHandled(chatId: number, messageId: number): boolean {
    const key = `${chatId}:${messageId}`;
    const at = seenMessages.get(key);
    if (at !== undefined && Date.now() - at < SEEN_MESSAGE_TTL_MS) return true;
    seenMessages.delete(key);
    seenMessages.set(key, Date.now());
    if (seenMessages.size > MAX_SEEN_MESSAGES) seenMessages.delete(seenMessages.keys().next().value!);
    return false;
  }

  bot.api.config.use(apiThrottler());
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
    const key = ctx.message ? sessionKeyFor(ctx.chat!.id, topicOf(ctx.message)) : undefined;
    if (key) preparing.set(key, (preparing.get(key) ?? 0) + 1);
    try {
      await next();
    } finally {
      if (key) {
        const left = (preparing.get(key) ?? 1) - 1;
        if (left > 0) {
          preparing.set(key, left);
        } else {
          preparing.delete(key);
          if (bursts.get(key)?.held) flushBurst(key);
        }
      }
    }
  });

  // Per-chat/per-topic ordering of message *preparation* only (commands, media
  // transcription) — turns run outside the lane (enqueueTurn/flushBurst), so a
  // message arriving mid-turn still reaches the runner and steers. /stop keeps
  // its escape lane to bypass even a slow preparation (e.g. a long transcription).
  bot.use(
    sequentialize((ctx) => {
      const chat = ctx.chat?.id;
      if (chat === undefined) return undefined;
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
        return changed;
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
    enqueueTurn(target, prompt, media.images);
  }

  async function handleCallback(ctx: Context) {
    const config = deps.botConfig();
    const from = ctx.callbackQuery?.from;
    if (!config || !from || !ctx.chat) return;
    // Same access policy as messages, minus the mention gate (a button press is explicit).
    if (senderAccess(ctx.chat, from.id, config) !== "ok") return;
    // Fire-and-forget: holding the prep lane for the whole turn would block
    // (and un-steer) every message behind it.
    void runTurn(targetFromContext(ctx), `[inline button pressed] ${ctx.callbackQuery!.data}`, []);
  }

  async function runTurn(target: Target, text: string, images: InboundImage[]) {
    const { chatId, topic, isPrivate } = target;
    const sessionKey = sessionKeyFor(chatId, topic);

    void bot.api.sendChatAction(chatId, "typing", { message_thread_id: topic }).catch(() => {});

    // Native draft streaming previews the reply as it generates (private chats only).
    const stream = isPrivate ? new DraftStream(bot.api, chatId, topic) : undefined;
    const blocks: string[] = [];
    let current = "";
    let flushedEarly = false;

    const { tool, sent } = toolFor(chatId, topic);

    const sendOptions = {
      messageThreadId: topic,
      replyParameters:
        !isPrivate && target.triggerMessageId !== undefined
          ? { message_id: target.triggerMessageId, allow_sending_without_reply: true }
          : undefined,
    };
    const taskProgress = new TelegramTaskProgress(
      bot.api,
      chatId,
      topic,
      sendOptions.replyParameters,
    );
    // A turn that produces no event at all (a provider stalling on the first
    // request) still owes the chat a sign of life — the typing action expires in
    // five seconds and says nothing about a turn that takes minutes.
    taskProgress.start();

    // Appends accumulate outermost→innermost: DMs use the user's; groups use group, then topic.
    const config = deps.botConfig();
    const group = config?.groups?.[String(chatId)];
    const topicConfig = topic !== undefined ? group?.topics?.[String(topic)] : undefined;
    const appends = (
      isPrivate
        ? [config?.users?.[String(target.userId)]?.appendSystemPrompt]
        : [group?.appendSystemPrompt, topicConfig?.appendSystemPrompt]
    ).filter((a): a is string => !!a);
    try {
      await deps.gateway.handle({
        sessionKey,
        text,
        images,
        workspaceHint: deps.workspace(),
        // Most specific first: a topic's model settings beat its group's.
        modelScopes: [topicConfig, group],
        appends,
        customTools: [tool],
        runtime: {
          channel: "telegram",
          conversation: describeConversation(target, config),
          capabilities: ["rich markdown (headings/tables/spoilers render natively)", "inline buttons", "media files", "reactions — via the telegram tool"],
        },
        events: {
          onDelta: (delta) => {
            current += delta;
            stream?.update([...blocks, current].join("\n\n"));
          },
          onAssistantText: () => {
            if (current.trim()) blocks.push(current.trim());
            current = "";
          },
          // A steered message just entered the turn — deliver the prose that
          // preceded it now, so replies land in timeline order instead of a
          // stale answer arriving glued to the final one.
          onEvent: (event) => {
            if (event.type !== "message_end" || event.message.role !== "user") return;
            const chunk = blocks.splice(0).join("\n\n").trim();
            if (!chunk || sent.has(chunk)) return;
            flushedEarly = true;
            void sendRich(bot.api, chatId, chunk, sendOptions).catch((error) => log.warn(`mid-turn flush failed: ${error}`));
          },
          // Failover abandons the attempt's prose — drop our copy of it too.
          onFailover: () => {
            blocks.length = 0;
            current = "";
          },
          onTaskActivity: (activity) => taskProgress.update(activity),
          onToolCall: (name, args) => taskProgress.tool(name, summarizeToolArgs(args)),
          onRetry: (notice) => taskProgress.retry(notice),
        },
        // The final send runs inside the turn's durable window: the pending
        // ledger releases only after this settles, so a daemon death before
        // Telegram confirms the send wakes the conversation instead of
        // silently losing the reply. A steered message never gets here — the
        // owning turn's deliver ships the combined result (and clears `sent`).
        deliver: async (result) => {
          await taskProgress.finish(result.status === "stopped" ? "stopped" : "completed");
          // After a mid-turn flush, result.text still contains the flushed
          // prose — deliver only what accumulated since.
          const final = (flushedEarly ? blocks.join("\n\n") : result.text).trim();
          const duplicate = !!final && sent.has(final);
          sent.clear(); // the turn is over — next one starts clean
          if (!final || duplicate) return;
          await sendRich(bot.api, chatId, final, sendOptions);
        },
      });
    } catch (error) {
      sent.clear();
      await taskProgress.finish("failed");
      log.error(`turn failed: ${error}`);
      await sendRich(bot.api, chatId, `⚠️ ${error instanceof Error ? error.message : error}`, { messageThreadId: topic }).catch(() => {});
    } finally {
      // The turn is over — stop the draft preview so a throttled/flood-delayed
      // flush can't re-post a stale draft after the final reply has landed.
      stream?.cancel();
      taskProgress.cancel();
    }
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
    const reply = (markdown: string) => sendRich(ctx.api, chat.id, markdown, { messageThreadId: topic }).then(() => true);

    switch (command.replace(`@${handle.username}`, "")) {
      case "/start":
        return reply(`Hi! I'm **${name}** running on eleven.\nYour user id: \`${ctx.from?.id}\``);
      case "/new": {
        // Fresh means fresh: drop buffered input and abort the in-flight turn,
        // so neither bleeds into (or races) the new conversation.
        discardBurst(sessionKey);
        await deps.gateway.interrupt(sessionKey);
        deps.gateway.newThread(sessionKey, deps.workspace());
        return reply("🧵 Fresh thread started.");
      }
      case "/skills": {
        const { workspace, skills } = await deps.gateway.listSkills(sessionKey, deps.workspace());
        if (!skills.length) return reply(`No skills loaded for **${workspace}**.`);
        const lines = skills.map((s) => `- \`${s.name}\` — ${s.description.length > 90 ? `${s.description.slice(0, 90)}…` : s.description}`);
        return reply(`**${skills.length} skills** loaded for **${workspace}**:\n${lines.join("\n")}`);
      }
      case "/usage": {
        try {
          return reply(await deps.gateway.providerUsage());
        } catch (error) {
          log.warn(`usage lookup failed: ${error}`);
          return reply(`⚠️ ${error instanceof Error ? error.message : error}`);
        }
      }
      case "/stop": {
        const dropped = discardBurst(sessionKey);
        const stopped = await deps.gateway.interrupt(sessionKey);
        return reply(stopped || dropped ? "⏹ Stopped." : "Nothing running.");
      }
      default:
        return false; // unknown command → goes to the agent as text
    }
  }

  /** Keep the config registry in sync with live traffic: group titles heal on
   * any message; forum topics register themselves (with their name) when they
   * first speak. Saves only when something actually changed. */
  function maintainGroupRegistry(ctx: Context, config: ChannelConfig) {
    const message = ctx.message!;
    const chatId = String(ctx.chat!.id);
    if (!config.groups?.[chatId]) return; // unregistered → the pairing path owns it

    const chatTitle = (ctx.chat as { title?: string }).title;
    const topicId = message.message_thread_id !== undefined && message.is_topic_message ? String(message.message_thread_id) : undefined;
    const topicName =
      message.forum_topic_created?.name ??
      message.forum_topic_edited?.name ??
      (message.reply_to_message as { forum_topic_created?: { name?: string } } | undefined)?.forum_topic_created?.name;

    deps.updateGroup(chatId, (group) => {
      let changed = false;
      if (chatTitle && group.title !== chatTitle) {
        group.title = chatTitle;
        changed = true;
      }
      if (!topicId) return changed;
      const topics = (group.topics ??= {});
      let topic = topics[topicId];
      if (!topic) {
        topic = topics[topicId] = {};
        changed = true;
      }
      if (topicName && topic.title !== topicName) {
        topic.title = topicName;
        changed = true;
      }
      return changed;
    });
  }

  function offerPairing(ctx: Context) {
    const from = ctx.from!;
    const chat = ctx.chat!;
    const isGroup = chat.type !== "private";
    const { request, isNew } = deps.pairing.request({
      kind: isGroup ? "group" : "dm",
      bot: name,
      userId: from.id,
      chatId: chat.id,
      chatTitle: isGroup ? (chat as { title?: string }).title : undefined,
      username: from.username,
      name: fullName(from),
    });
    if (!isNew) return; // already pending; stay quiet instead of spamming
    log.info(`pairing request (${request.kind}) from ${from.id} (@${from.username}) chat ${chat.id}`);
    if (!isGroup) {
      // Groups stay silent — the request just shows up in the dashboard.
      void sendRich(ctx.api, chat.id, "This bot is private. I've asked the owner to approve you — hang tight.").catch(() => {});
    }
  }

  /** Chat-level access: is this sender allowed here at all? (mention gating is separate) */
  function senderAccess(chat: { type: string; id: number }, userId: number, config: ChannelConfig): "ok" | "pair" | "ignore" {
    if (chat.type === "private") {
      return config.users?.[String(userId)] ? "ok" : "pair";
    }
    // Unregistered group → surface a pairing request instead of silence.
    if (!config.groups?.[String(chat.id)]) return "pair";
    const allowed = config.groupAllowedUsers ?? Object.keys(config.users ?? {}).map(Number);
    return allowed.includes(userId) ? "ok" : "ignore";
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
    if (target.isPrivate) {
      const user = config?.users?.[String(target.userId)];
      const name = user?.name || "user";
      return `DM with ${name}${user?.username ? ` (@${user.username})` : ""}`;
    }
    const group = config?.groups?.[String(target.chatId)];
    const title = group?.title ?? String(target.chatId);
    if (target.topic === undefined) return `group "${title}"`;
    const topicTitle = group?.topics?.[String(target.topic)]?.title;
    return `group "${title}", topic ${topicTitle ? `"${topicTitle}"` : target.topic}`;
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
    // Flush pending bursts immediately: the turn registers as in-flight, so a
    // restart wakes the conversation instead of silently dropping the messages.
    for (const key of [...bursts.keys()]) {
      const burst = bursts.get(key)!;
      clearTimeout(burst.timer);
      flushBurst(key);
    }
    await runner?.stop().catch(() => {});
  }

  return handle;
}

function fullName(user?: { first_name?: string; last_name?: string }): string {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ");
}

/** A forum topic id, but only when the message truly belongs to a topic.
 * Telegram also sets message_thread_id on plain replies in non-forum
 * supergroups, so keying a session on it there would fork phantom threads and
 * send with a thread id the chat rejects. */
function topicOf(message: { message_thread_id?: number; is_topic_message?: boolean } | undefined): number | undefined {
  return message?.is_topic_message ? message.message_thread_id : undefined;
}

const REPLY_QUOTE_LIMIT = 200;
const REPLY_QUOTE_HEAD = 120;
const REPLY_QUOTE_TAIL = 70;

/** Compact per-message attribution for shared conversations. Message ids stay
 * in the transport layer: the gateway already replies to the triggering id,
 * and exposing them to the model would spend tokens without improving prose. */
export function formatTelegramInboundPrompt(ctx: Context, body: string): string {
  if (ctx.chat?.type === "private") return body;
  const message = ctx.message;
  const lines = [`[${senderLabel(message?.from)}]`];
  const replied = message?.reply_to_message;
  if (replied) {
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

function senderLabel(user?: { id?: number; first_name?: string; last_name?: string; username?: string }): string {
  const name = sanitizeContextLabel(fullName(user));
  const username = sanitizeContextLabel(user?.username ?? "");
  if (name && username) return `${name} @${username}`;
  if (name) return name;
  if (username) return `@${username}`;
  return user?.id !== undefined ? `Telegram user ${user.id}` : "Unknown sender";
}

function sanitizeContextLabel(value: string): string {
  return value.replaceAll("[", "(").replaceAll("]", ")").replaceAll(/\s+/g, " ").trim();
}

function compactReplyQuote(text: string): string {
  const chars = [...text.replaceAll(/\s+/g, " ").trim()];
  if (chars.length <= REPLY_QUOTE_LIMIT) return chars.join("");
  return `${chars.slice(0, REPLY_QUOTE_HEAD).join("")}…${chars.slice(-REPLY_QUOTE_TAIL).join("")}`;
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

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BackgroundStatus } from "../agent/host-api.ts";
import type { ChannelConfig, ChannelType } from "../config.ts";
import type { logger } from "../log.ts";
import { lruTouch } from "../util.ts";
import { BackgroundStatuses } from "./background.ts";
import type { BotDeps } from "./bots.ts";
import { Bursts } from "./burst.ts";
import { runCommand } from "./commands.ts";
import { continuePrompt, FailoverOffers } from "./failover.ts";
import type { PairingRequest } from "./pairing.ts";
import { parseSessionKey, scopesOf } from "./session-key.ts";
import { createSeenMessages, foldDisplayName } from "./text.ts";
import { runChatTurn, WAKE_PROMPT, type ChatTurn, type TurnRetry } from "./turn.ts";

const MAX_CONVERSATIONS = 128;

/** Where a turn lands, as its platform knows it. The message that triggered it
 *  is the one acked and replied to. */
export interface ChatTarget {
  triggerMessageId?: string | number;
}

/** How one turn reaches its chat. */
export interface TurnSurface {
  status: ChatTurn<unknown>["status"];
  send: ChatTurn<unknown>["send"];
  /** Draw the status of a run the turn left in the background, with the button
   *  that stops it. Platforms without buttons leave it out. */
  attach?: (title: string, stopId: string) => BackgroundStatus;
}

/** What a bot tells the conversations about its platform. */
export interface ChatPlatform<T extends ChatTarget> {
  type: ChannelType;
  /** The channel's configured name. */
  name: string;
  deps: BotDeps;
  log: ReturnType<typeof logger>;
  sessionKey(target: T): string;
  /** A session key back into a target — a wake-up or a literal send has no
   *  live event to read one from. Undefined (or a throw) when the key is not
   *  one of this bot's. */
  targetOf(sessionKey: string): T | undefined | Promise<T | undefined>;
  /** Open the chat for one turn. A throw means there is nowhere to answer. */
  surface(target: T): TurnSurface | Promise<TurnSurface>;
  /** The conversation as the system prompt names it. */
  describe(target: T, config: ChannelConfig | undefined): string;
  /** What the chat can render, as the system prompt lists it. */
  capabilities: string[];
  /** The agent's tools for one conversation. Built once per conversation: the
   *  runner only reuses a warm session when the tools are the same objects
   *  across turns. `onSent` reports text a tool put in the chat. */
  tools?(target: T, onSent: (text: string) => void): ToolDefinition[];
  /** Runs once a turn (and whatever auto-failover chained onto it) is over. */
  afterTurn?(target: T, sessionKey: string): Promise<void>;
}

/** What a stranger's knock carries, before it becomes a pairing request. */
export interface Knock {
  kind: PairingRequest["kind"];
  userId: string;
  chatId: string;
  chatTitle?: string;
  origin?: string;
  username?: string;
  /** The name as the platform reports it, lookalike unicode and all. */
  displayName: string;
  /** The requester's picture as a `data:` URL. Fetched only for a first knock. */
  photo?: () => Promise<string | undefined>;
}

/**
 * Everything a bot does with a conversation that does not depend on its
 * platform: coalescing bursts of messages into turns, running those turns with
 * the conversation's own tools and scopes, picking failed ones back up, waking
 * one nobody typed in, answering commands, and filing strangers as pairing
 * requests. A platform says how its chat is reached (`ChatPlatform`) and feeds
 * prepared messages in.
 */
export class Conversations<T extends ChatTarget> {
  /** Prepared messages waiting out the quiet window before becoming a turn. */
  readonly bursts: Bursts<T>;
  /** Whether a message was already handled (platforms redeliver). */
  readonly seen = createSeenMessages();
  // Manual failover buttons hanging off failure messages, each holding what it
  // takes to run that turn again.
  private failovers = new FailoverOffers<{ target: T; text: string; images: ImageContent[] }>();
  private background = new BackgroundStatuses();
  // One entry per conversation. `sent` collects the texts any route already put
  // in the chat; the owning turn clears it when it ends.
  private open = new Map<string, { sent: Set<string>; tools?: ToolDefinition[] }>();
  private platform: ChatPlatform<T>;

  constructor(platform: ChatPlatform<T>) {
    this.platform = platform;
    this.bursts = new Bursts<T>((target, text, images) => void this.runTurn(target, text, images));
  }

  private conversation(target: T, sessionKey: string) {
    let entry = lruTouch(this.open, sessionKey);
    if (!entry) {
      const sent = new Set<string>();
      const tools = this.platform.tools?.(target, (text) => sent.add(text));
      entry = { sent, tools: tools?.length ? tools : undefined };
      this.open.set(sessionKey, entry);
      if (this.open.size > MAX_CONVERSATIONS) this.open.delete(this.open.keys().next().value!);
    }
    return entry;
  }

  /** Run one turn end to end. `retry` is set by a manual failover: its own
   *  model plan for this turn alone, and the failed attempt a restart branches
   *  away first. */
  async runTurn(target: T, text: string, images: ImageContent[], retry?: TurnRetry, expectedThreadId?: string): Promise<void> {
    const { platform } = this;
    const { deps, log } = platform;
    const sessionKey = platform.sessionKey(target);
    let surface: TurnSurface;
    try {
      surface = await platform.surface(target);
    } catch (error) {
      return void log.error(`turn in ${sessionKey} has nowhere to answer: ${error}`);
    }
    const { attach } = surface;
    const { sent, tools } = this.conversation(target, sessionKey);

    // Whatever owns this conversation: the person in a DM, the group in a
    // group — and inside either, the topic it runs in with the topics around
    // that one, innermost first.
    const config = deps.botConfig();
    const parsed = parseSessionKey(sessionKey);
    const { owner, topics } = parsed ? scopesOf(parsed, config) : { owner: undefined, topics: [] };
    // Appends accumulate outermost→innermost: the owner's, then each topic's.
    const appends = [owner, ...[...topics].reverse()].map((scope) => scope?.appendSystemPrompt).filter((append): append is string => !!append);
    const autoRetry = await runChatTurn({
      gateway: deps.gateway,
      sessionKey,
      text,
      images,
      retry,
      replyTo: target.triggerMessageId?.toString(),
      incoming: {
        expectedThreadId,
        createBackground: attach && ((options) => this.background.create(sessionKey, options, (stopId) => attach(options.title, stopId))),
        workspaceHint: deps.workspace(),
        // Most specific first: a topic's model settings beat the ones around
        // it, which beat its owner's.
        modelScopes: [...topics, owner],
        appends,
        customTools: tools,
        runtime: { channel: platform.type, conversation: platform.describe(target, config), capabilities: platform.capabilities },
      },
      sent,
      status: surface.status,
      send: surface.send,
      failovers: this.failovers,
      replay: { target, text, images },
      autoFailover: deps.autoFailover,
      log,
    });
    // A turn of its own, with its own status message and its own failure
    // handling (including, if it comes to it, the next failover — the plan it
    // carries is strictly shorter, so the chain ends).
    if (autoRetry) await this.runTurn(target, autoRetry.text, [], { models: autoRetry.models });
    else await platform.afterTurn?.(target, sessionKey);
  }

  /** Start a turn nobody typed. By default it resumes a conversation a restart
   *  cut off. */
  async wake(sessionKey: string, text = WAKE_PROMPT, threadId?: string): Promise<void> {
    const target = await this.platform.targetOf(sessionKey);
    if (!target) throw new Error(`cannot wake ${sessionKey}: unrecognized session key`);
    this.platform.log.info(`waking ${sessionKey}`);
    await this.runTurn(target, text, [], undefined, threadId);
  }

  /** The person took one of the two ways out a failed turn offered: pick the
   *  dead turn up where it stopped, or run the original request from nothing —
   *  both on the models its plan never reached. False when that offer is gone. */
  retryOnFallback(data: string, target: T): boolean {
    const sessionKey = this.platform.sessionKey(target);
    const offer = this.failovers.take(data, sessionKey);
    if (!offer) return false;
    const { replay, models, mode } = offer;
    this.platform.log.info(`manual failover in ${sessionKey}: ${mode} on ${models[0]!.model}`);
    const restart = mode === "restart";
    void this.runTurn(replay.target, restart ? replay.text : continuePrompt(offer.hiddenToolCalls), restart ? replay.images : [], {
      models,
      // A continue keeps the failed attempt: its tool calls are what the next
      // model resumes from. Only a restart branches them away.
      rewind: restart ? offer.rewind : undefined,
    });
    return true;
  }

  /** Stop a background run from the button its status carries. */
  stopBackground(sessionKey: string, data: string): boolean {
    return this.background.stop(sessionKey, data);
  }

  /** Answer one of the commands every channel handles itself; undefined for
   *  anything else, which goes to the agent as text. */
  command(name: string, sessionKey: string): Promise<string | undefined> {
    const { deps, log } = this.platform;
    return runCommand(name, { gateway: deps.gateway, sessionKey, workspace: deps.workspace(), discardBurst: () => this.bursts.discard(sessionKey), log });
  }

  /** File a stranger (or an unregistered group) as a pairing request. Returns
   *  it the first time only: someone already pending stays pending, quietly,
   *  and never costs a second picture download. */
  async knock(knock: Knock): Promise<PairingRequest | undefined> {
    const { deps, name: bot } = this.platform;
    const { kind, userId, chatId } = knock;
    if (deps.pairing.find({ bot, kind, userId, chatId })) return undefined;
    const { name, disguised } = foldDisplayName(knock.displayName);
    // Fetched before registering: the request the dashboard is pushed already
    // carries the face.
    const photo = await knock.photo?.();
    const { request, isNew } = deps.pairing.request({
      kind,
      bot,
      userId,
      chatId,
      chatTitle: knock.chatTitle,
      origin: knock.origin,
      username: knock.username,
      name: name || undefined,
      disguised: disguised || undefined,
      photo,
    });
    return isNew ? request : undefined;
  }

  /** Flush every pending burst now: its turn registers as in-flight, so a
   *  restart wakes the conversation instead of silently dropping the messages. */
  stop(): void {
    this.bursts.flushAll();
  }
}

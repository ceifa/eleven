import type { ChannelConfig, ChannelType, ModelScope, ThreadPlacement, TopicConfig, UserConfig, GroupConfig } from "../config.ts";
import { parseDiscordSessionKey } from "./discord/session-key.ts";
import { parseGoogleChatSessionKey } from "./googlechat/session-key.ts";
import { parseTelegramSessionKey } from "./telegram/session-key.ts";

/**
 * A channel conversation as the registry files it: under its owner — a person
 * (`users`) or a group (`groups`: a Telegram chat, a Discord server) — and,
 * inside a forum, under one of the owner's topics (a forum topic, a Discord
 * channel or thread). Both platforms reduce to this shape, which is what lets
 * naming and model scoping be written once.
 */
export interface ConversationTarget {
  type: ChannelType;
  /** The channel's configured name. */
  channel: string;
  owner: { kind: "user" | "group"; id: string };
  topic?: string;
}

export function parseSessionKey(sessionKey: string): ConversationTarget | undefined {
  const telegram = parseTelegramSessionKey(sessionKey);
  if (telegram) {
    return {
      type: "telegram",
      channel: telegram.channel,
      // Positive ids are people, negative ones are groups — Telegram's own split.
      owner: { kind: telegram.chatId > 0 ? "user" : "group", id: String(telegram.chatId) },
      topic: telegram.topic === undefined ? undefined : String(telegram.topic),
    };
  }
  const discord = parseDiscordSessionKey(sessionKey);
  if (discord) {
    return {
      type: "discord",
      channel: discord.channel,
      owner: discord.guildId ? { kind: "group", id: discord.guildId } : { kind: "user", id: discord.userId! },
      topic: discord.channelId,
    };
  }
  const googlechat = parseGoogleChatSessionKey(sessionKey);
  if (googlechat) {
    return {
      type: "googlechat",
      channel: googlechat.channel,
      owner: googlechat.userId ? { kind: "user", id: googlechat.userId } : { kind: "group", id: googlechat.spaceId! },
      topic: googlechat.threadId,
    };
  }
  return undefined;
}

// Discord nests a thread in a channel in a category; nothing goes deeper.
const MAX_TOPIC_DEPTH = 4;

type TopicOwner = { topics?: Record<string, TopicConfig>; threads?: Record<string, ThreadPlacement> };

/** The Discord thread a conversation happens in, when it is filed as one. A
 *  thread still configured as a topic of its own (from before threads stopped
 *  being topics) is that topic instead. */
export function threadOf(owner: TopicOwner | undefined, topicId: string | undefined): ThreadPlacement | undefined {
  if (topicId === undefined || owner?.topics?.[topicId]) return undefined;
  return owner?.threads?.[topicId];
}

/** A topic and the ones it sits in, innermost first; a thread starts at its
 *  channel, whose settings it runs on. A registry edited into a loop stops at
 *  the depth nothing real reaches. */
export function topicChain(owner: TopicOwner | undefined, topicId: string | undefined): TopicConfig[] {
  const chain: TopicConfig[] = [];
  for (let id = threadOf(owner, topicId)?.parent ?? topicId; id !== undefined && chain.length < MAX_TOPIC_DEPTH; ) {
    const topic = owner?.topics?.[id];
    if (!topic) break;
    chain.push(topic);
    id = topic.parent;
  }
  return chain;
}

/** The registry entries a conversation sits under, if it has them: its owner,
 *  and its topic with the topics that contain it, innermost first. */
export function scopesOf(target: ConversationTarget, channel: ChannelConfig | undefined): { owner?: UserConfig | GroupConfig; topics: TopicConfig[] } {
  const owner = target.owner.kind === "user" ? channel?.users?.[target.owner.id] : channel?.groups?.[target.owner.id];
  return { owner, topics: topicChain(owner, target.topic) };
}

/** The model scopes a channel conversation runs under, most specific first
 * (the topic, the topics around it, then the owner). */
export function conversationModelScopes(sessionKey: string, channels: ChannelConfig[]): (ModelScope | undefined)[] {
  const target = parseSessionKey(sessionKey);
  if (!target) return [];
  const { owner, topics } = scopesOf(target, channels.find((channel) => channel.name === target.channel));
  return [...topics, owner];
}

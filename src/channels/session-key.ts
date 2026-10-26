import type { ChannelConfig, ChannelType, ModelScope, TopicConfig, UserConfig, GroupConfig } from "../config.ts";
import { parseDiscordSessionKey } from "./discord/session-key.ts";
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
  return undefined;
}

/** The registry entries a conversation sits under, if it has them. */
export function scopesOf(target: ConversationTarget, channel: ChannelConfig | undefined): { owner?: UserConfig | GroupConfig; topic?: TopicConfig } {
  const owner = target.owner.kind === "user" ? channel?.users?.[target.owner.id] : channel?.groups?.[target.owner.id];
  return { owner, topic: target.topic === undefined ? undefined : owner?.topics?.[target.topic] };
}

/** The model scopes a channel conversation runs under, most specific first
 * (topic, then owner). */
export function conversationModelScopes(sessionKey: string, channels: ChannelConfig[]): (ModelScope | undefined)[] {
  const target = parseSessionKey(sessionKey);
  if (!target) return [];
  const { owner, topic } = scopesOf(target, channels.find((channel) => channel.name === target.channel));
  return [topic, owner];
}

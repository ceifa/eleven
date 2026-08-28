import type { ChannelConfig } from "../config.ts";
import { parseTelegramSessionKey } from "../channels/telegram/session-key.ts";

/**
 * How a conversation is named for a human. A session key is precise and
 * unreadable (`telegram:main:-100123:topic:42`); what identifies a thread at a
 * glance is the forum topic it happens in, or the group, or the person on the
 * other end of the DM — so that is the headline, and the rest is context.
 */
export interface ConversationIdentity {
  /** The headline: the topic, the group, or the person. */
  name: string;
  /** Where `name` lives, when the name alone isn't the whole story. */
  context?: string;
  /** The full one-line reading, channel spelled out. */
  label: string;
}

/**
 * Names a conversation from its session key and the channel registry that holds
 * the human-readable titles (group titles and topic names self-heal from live
 * traffic, so they're generally there). Falls back to raw ids rather than
 * inventing anything: an unnamed chat is better shown as its id than as "?".
 */
export function conversationIdentity(sessionKey: string, channels: ChannelConfig[] = []): ConversationIdentity {
  const target = parseTelegramSessionKey(sessionKey);
  if (!target) {
    const source = sessionKey.split(":", 1)[0];
    const name = source === "dashboard" ? "Dashboard" : source === "cli" ? "CLI" : source;
    return { name, label: name };
  }

  const channel = channels.find((entry) => entry.name === target.channel);
  const chatKey = String(target.chatId);
  // Positive ids are people, negative ones are groups — Telegram's own split.
  if (target.chatId > 0) {
    const user = channel?.users?.[chatKey];
    const name = user?.name || (user?.username ? `@${user.username}` : chatKey);
    return { name, context: "Telegram DM", label: `Telegram DM · ${name}` };
  }

  const group = channel?.groups?.[chatKey];
  const groupName = group?.title || chatKey;
  if (target.topic === undefined) return { name: groupName, context: "Telegram", label: `Telegram · ${groupName}` };
  // Inside a forum the topic is the conversation; the group is where it sits.
  const topicName = group?.topics?.[String(target.topic)]?.title || `topic ${target.topic}`;
  return { name: topicName, context: groupName, label: `Telegram · ${groupName} · ${topicName}` };
}

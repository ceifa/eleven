import type { ChannelConfig, ChannelType } from "../config.ts";
import { parseSessionKey, topicChain } from "../channels/session-key.ts";

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
  /** What the platform draws for it, when that is a picture: the chat's (or
   *  server's, or person's) photo, or a Telegram topic's custom emoji. */
  picture?: { kind: "photo" | "emoji"; version: string };
  /** A topic's own colour (0xRRGGBB) — Telegram's bubble behind its initial. */
  color?: number;
}

const PLATFORM: Record<ChannelType, string> = { telegram: "Telegram", discord: "Discord" };

/**
 * Names a conversation from its session key and the channel registry that holds
 * the human-readable titles (group titles and topic names self-heal from live
 * traffic, so they're generally there). Falls back to raw ids rather than
 * inventing anything: an unnamed chat is better shown as its id than as "?".
 */
export function conversationIdentity(sessionKey: string, channels: ChannelConfig[] = []): ConversationIdentity {
  const target = parseSessionKey(sessionKey);
  if (!target) {
    const source = sessionKey.split(":", 1)[0];
    const name = source === "dashboard" ? "Dashboard" : source === "cli" ? "CLI" : source;
    return { name, label: name };
  }

  const channel = channels.find((entry) => entry.name === target.channel);
  const inDm = target.owner.kind === "user";
  const user = inDm ? channel?.users?.[target.owner.id] : undefined;
  const group = inDm ? undefined : channel?.groups?.[target.owner.id];
  // Whoever holds the topics: the person in a DM, the group in a group.
  const owner = user ?? group;
  const [topic, ...around] = topicChain(owner, target.topic);
  const ownerName = (inDm ? user?.name || (user?.username && `@${user.username}`) : group?.title) || target.owner.id;
  const channelContext = `${PLATFORM[target.type]}${inDm ? " DM" : ""}`;
  if (target.topic === undefined) {
    return {
      name: ownerName,
      context: channelContext,
      label: `${channelContext} · ${ownerName}`,
      // Worth asking for only once the chat is registered: the daemon serves
      // pictures of the conversations it knows and no others.
      ...(owner && { picture: { kind: "photo", version: "1" } as const }),
    };
  }
  // Inside a forum the topic is the conversation; the group — or, in a DM with
  // topic mode, the person — is where it sits, along with whatever the topic
  // is nested in (a Discord channel's category, a thread's channel).
  const topicName = topic?.title || `${target.type === "discord" ? "channel" : "topic"} ${target.topic}`;
  const where = [ownerName, ...around.reverse().flatMap((parent) => parent.title ?? [])].join(" › ");
  return {
    name: topicName,
    context: inDm ? `${channelContext} · ${where}` : where,
    label: `${channelContext} · ${where} · ${topicName}`,
    // The emoji's id is the version: a topic that changes its icon names a
    // new picture, and no cache anywhere keeps showing the old one.
    ...(topic?.iconEmojiId && { picture: { kind: "emoji", version: topic.iconEmojiId } as const }),
    ...(topic?.iconColor !== undefined && { color: topic.iconColor }),
  };
}

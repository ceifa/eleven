/** The one place that understands the Discord session-key wire format:
 * `discord:<channel>:dm:<userId>` for a DM, `discord:<channel>:<guildId>:<channelId>`
 * for a server's channel or thread. A DM is keyed by the person rather than by
 * its channel, because the person is what the allowlist knows. */
export interface DiscordSessionTarget {
  channel: string;
  guildId?: string;
  userId?: string;
  channelId?: string;
}

export function discordSessionKey(channel: string, where: { userId: string } | { guildId: string; channelId: string }): string {
  return "userId" in where ? `discord:${channel}:dm:${where.userId}` : `discord:${channel}:${where.guildId}:${where.channelId}`;
}

export function parseDiscordSessionKey(sessionKey: string): DiscordSessionTarget | undefined {
  const match = sessionKey.match(/^discord:([^:]+):(dm|\d+):(\d+)$/);
  if (!match) return undefined;
  const [, channel, scope, id] = match;
  return scope === "dm" ? { channel, userId: id } : { channel, guildId: scope, channelId: id };
}

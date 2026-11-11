/** The one place that understands the Google Chat session-key wire format:
 * `googlechat:<channel>:dm:<userId>` for a DM, `googlechat:<channel>:<spaceId>:<threadId>`
 * for a thread in a space. Ids are the last segment of Chat's resource names
 * (`users/123`, `spaces/AAA`, `spaces/AAA/threads/BBB`). A DM is keyed by the
 * person, because the person is what the allowlist knows; in a space every
 * thread is its own conversation, the way people already use them. */
export interface GoogleChatSessionTarget {
  channel: string;
  userId?: string;
  spaceId?: string;
  threadId?: string;
}

export function googleChatSessionKey(channel: string, where: { userId: string } | { spaceId: string; threadId: string }): string {
  return "userId" in where ? `googlechat:${channel}:dm:${where.userId}` : `googlechat:${channel}:${where.spaceId}:${where.threadId}`;
}

export function parseGoogleChatSessionKey(sessionKey: string): GoogleChatSessionTarget | undefined {
  const match = sessionKey.match(/^googlechat:([^:]+):([\w-]+):([\w-]+)$/);
  if (!match) return undefined;
  const [, channel, scope, id] = match;
  return scope === "dm" ? { channel, userId: id } : { channel, spaceId: scope, threadId: id };
}

/** The id at the end of a Chat resource name. */
export function resourceId(name: string | undefined): string | undefined {
  const id = name?.split("/").at(-1);
  return id && /^[\w-]+$/.test(id) ? id : undefined;
}

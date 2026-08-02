/** The one place that understands the Telegram session-key wire format:
 * `telegram:<channel>:<chatId>[:topic:<topicId>]`. */
export interface TelegramSessionTarget {
  channel: string;
  chatId: number;
  topic?: number;
}

export function parseTelegramSessionKey(sessionKey: string): TelegramSessionTarget | undefined {
  const match = sessionKey.match(/^telegram:([^:]+):(-?\d+)(?::topic:(\d+))?$/);
  if (!match) return undefined;
  return {
    channel: match[1],
    chatId: Number(match[2]),
    topic: match[3] !== undefined ? Number(match[3]) : undefined,
  };
}

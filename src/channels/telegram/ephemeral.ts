/**
 * Ephemeral delivery — a message only one member of a group sees — is a Bot API
 * courtesy Telegram grants to admins only. eleven never *requires* admin: a chat
 * that refuses ephemeral gets ordinary messages instead, and the refusal is
 * remembered so it costs one rejected call per chat rather than one per message.
 *
 * The memory is in-process on purpose. It is cleared when the bot's own
 * membership in that chat changes (see the `my_chat_member` handler), so
 * promoting the bot to admin turns ephemeral back on without a restart.
 */
const refused = new Set<string>();

/** The user to deliver ephemerally to, or `undefined` where this chat has
 * already refused — the caller then sends an ordinary message. */
export function ephemeralReceiver(chatId: number | string, receiver: number | undefined): number | undefined {
  if (receiver === undefined || refused.has(String(chatId))) return undefined;
  return receiver;
}

export function noteEphemeralRefused(chatId: number | string): void {
  refused.add(String(chatId));
}

/** The bot's rights in this chat changed — probe ephemeral again. */
export function forgetEphemeralRefusal(chatId: number | string): void {
  refused.delete(String(chatId));
}

/** A chat that won't take an ephemeral message — the bot is not an admin there,
 * or the chat type doesn't support one. */
export function isEphemeralRejected(error: unknown): boolean {
  return /BOT_NOT_ADMIN|EPHEMERAL/i.test(String((error as { description?: string })?.description ?? error));
}

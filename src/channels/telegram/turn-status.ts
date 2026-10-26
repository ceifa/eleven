import type { Api } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import { plainStatus, TurnStatus } from "../turn-status.ts";
import { isNoop, withRetry } from "./retry.ts";

// A DM tolerates roughly one message per second; a group is flood-limited at
// about twenty per minute, and going faster earns a 429 that stalls everything
// else queued for that chat.
const THROTTLE_MS = 900;
const GROUP_THROTTLE_MS = 3_000;

export interface TelegramStatusOptions {
  topic?: number;
  replyParameters?: ReplyParameters;
  /** Spacing between edits; defaults to what the chat kind tolerates. */
  throttleMs?: number;
  toolRenderDelayMs?: number;
  idleRenderDelayMs?: number;
}

/** The turn's status card as a quiet Telegram message. */
export class TelegramTurnStatus extends TurnStatus {
  constructor(api: Api, chatId: number, options: TelegramStatusOptions = {}) {
    let messageId: number | undefined;
    // Telegram ids tell the two apart: a private chat's id is the user's own and
    // is positive, groups and channels are negative. Only a group's limit is
    // per chat — a DM's is per user and looser, and the API throttler already
    // spaces those out on its own.
    const group = chatId < 0;
    super({
      post: async (text) => {
        const message = await withRetry("send", "send turn status", () =>
          api.raw.sendMessage({
            chat_id: chatId,
            message_thread_id: options.topic,
            text,
            reply_parameters: options.replyParameters,
            disable_notification: true,
          }),
        );
        messageId = message.message_id;
      },
      edit: async (text) => {
        try {
          await withRetry("idempotent", "edit turn status", () =>
            api.raw.editMessageText({ chat_id: chatId, message_id: messageId!, text }),
          );
        } catch (error) {
          if (!isNoop(error)) throw error;
        }
      },
      remove: async () => {
        try {
          await withRetry("idempotent", "delete turn status", () => api.raw.deleteMessage({ chat_id: chatId, message_id: messageId! }));
        } catch (error) {
          if (!isNoop(error)) throw error;
        }
      },
    }, {
      render: plainStatus,
      throttleMs: options.throttleMs ?? (group ? GROUP_THROTTLE_MS : THROTTLE_MS),
      rateKey: group ? `telegram:${chatId}` : undefined,
      toolRenderDelayMs: options.toolRenderDelayMs,
      idleRenderDelayMs: options.idleRenderDelayMs,
    });
  }
}

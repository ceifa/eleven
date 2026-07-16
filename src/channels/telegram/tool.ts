import { InputFile, type Api } from "grammy";
import type { InlineKeyboardButton } from "@grammyjs/types";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extname } from "node:path";
import { sendRich } from "./rich.ts";
import { withRetry, isNoop } from "./retry.ts";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("send"), Type.Literal("react"), Type.Literal("delete")], {
    description: "send a message/media, react to a message, or delete one of your messages",
  }),
  text: Type.Optional(Type.String({ description: "Markdown text (send). Used as caption when media is given." })),
  media: Type.Optional(Type.String({ description: "Absolute path of a local file to send (photo/video/audio/document)" })),
  asVoice: Type.Optional(Type.Boolean({ description: "Send audio as a voice note" })),
  buttons: Type.Optional(
    Type.Array(
      Type.Array(
        Type.Object({
          label: Type.String(),
          url: Type.Optional(Type.String()),
          data: Type.Optional(Type.String({ description: "callback data (≤64 bytes); sent back to you as text when pressed" })),
        }),
      ),
      { description: "Inline keyboard rows (max 3 buttons per row)" },
    ),
  ),
  messageId: Type.Optional(Type.Number({ description: "Target message id (react/delete)" })),
  emoji: Type.Optional(Type.String({ description: "Reaction emoji (react); omit to clear" })),
  silent: Type.Optional(Type.Boolean({ description: "Send without notification sound" })),
});

const MEDIA_KIND: Record<string, "photo" | "video" | "audio" | "document"> = {
  ".jpg": "photo", ".jpeg": "photo", ".png": "photo", ".webp": "photo", ".gif": "photo",
  ".mp4": "video", ".mov": "video", ".webm": "video",
  ".mp3": "audio", ".m4a": "audio", ".ogg": "audio", ".oga": "audio", ".flac": "audio", ".wav": "audio",
};

const CAPTION_LIMIT = 1024;

/**
 * The channel tool a Telegram-routed agent gets: proactive sends, media,
 * inline buttons, reactions. Plain prose replies don't need it — they are
 * delivered automatically. `onSent` reports sent text so the caller can avoid
 * delivering the same content twice.
 */
export function telegramTool(api: Api, chatId: number, messageThreadId?: number, onSent?: (text: string) => void): ToolDefinition {
  return defineTool({
    name: "telegram",
    label: "Telegram",
    description:
      "Interact with the current Telegram chat beyond your normal reply: send extra messages, " +
      "media files, inline buttons, reactions, or delete a message you sent. Your final answer " +
      "is delivered automatically — do NOT repeat content you already sent with this tool.",
    parameters,
    async execute(_id, params) {
      const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
      try {
        switch (params.action) {
          case "send": {
            if (params.media) {
              const message = await sendMedia(api, chatId, params, messageThreadId);
              return ok(`sent (message_id ${message.message_id})`);
            }
            if (!params.text) return ok("nothing to send: provide text or media");
            const message = await sendRich(api, chatId, params.text, {
              messageThreadId,
              replyMarkup: keyboard(params.buttons),
              silent: params.silent,
            });
            // Record only after a successful send, so a failed send doesn't make
            // the caller suppress the model's final answer as a "duplicate".
            onSent?.(params.text.trim());
            return ok(`sent (message_id ${message?.message_id})`);
          }
          case "react": {
            if (!params.messageId) return ok("react needs messageId");
            await withRetry("idempotent", "setMessageReaction", () =>
              api.setMessageReaction(chatId, params.messageId!, params.emoji ? [{ type: "emoji", emoji: params.emoji as never }] : []),
            );
            return ok("reacted");
          }
          case "delete": {
            if (!params.messageId) return ok("delete needs messageId");
            await withRetry("idempotent", "deleteMessage", () => api.deleteMessage(chatId, params.messageId!));
            return ok("deleted");
          }
        }
      } catch (error) {
        if (isNoop(error)) return ok("already done");
        return ok(`telegram error: ${error}`);
      }
    },
  });
}

function keyboard(rows?: { label: string; url?: string; data?: string }[][]) {
  if (!rows?.length) return undefined;
  const inline_keyboard: InlineKeyboardButton[][] = rows.map((row) =>
    row.slice(0, 3).map((b) =>
      b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: truncateBytes(b.data ?? b.label, 64) },
    ),
  );
  return { inline_keyboard };
}

/** Telegram's callback_data limit is 64 *bytes*, not characters — a naive
 * .slice(0, 64) lets multi-byte labels (emoji/CJK) through and gets the whole
 * message rejected. Trim to the byte budget without splitting a code point. */
function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off UTF-8 continuation bytes
  return buf.toString("utf8", 0, end);
}

async function sendMedia(api: Api, chatId: number, params: { media?: string; text?: string; asVoice?: boolean; silent?: boolean }, threadId?: number) {
  const file = new InputFile(params.media!);
  const caption = params.text?.slice(0, CAPTION_LIMIT);
  const common = { caption, disable_notification: params.silent, message_thread_id: threadId };
  const kind = params.asVoice ? "voice" : (MEDIA_KIND[extname(params.media!).toLowerCase()] ?? "document");
  return withRetry("send", `send ${kind}`, (): Promise<{ message_id: number }> => {
    switch (kind) {
      case "voice": return api.sendVoice(chatId, file, common);
      case "photo": return api.sendPhoto(chatId, file, common);
      case "video": return api.sendVideo(chatId, file, common);
      case "audio": return api.sendAudio(chatId, file, common);
      default: return api.sendDocument(chatId, file, common);
    }
  });
}

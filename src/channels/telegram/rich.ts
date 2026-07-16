import type { Api } from "grammy";
import type { InlineKeyboardMarkup, ReplyParameters } from "@grammyjs/types";
import { withRetry } from "./retry.ts";

/** Bot API rich message limit is 32768; keep headroom. */
const RICH_LIMIT = 32_000;

export interface RichSendOptions {
  messageThreadId?: number;
  replyParameters?: ReplyParameters;
  replyMarkup?: InlineKeyboardMarkup;
  silent?: boolean;
}

/**
 * Send agent markdown as one or more Bot API 10.1 rich messages. Rich messages
 * are eleven's only outbound text format — the agent's markdown passes through
 * as-is (native headings, tables, code, spoilers, collapsibles).
 */
export async function sendRich(api: Api, chatId: number | string, markdown: string, options: RichSendOptions = {}) {
  const chunks = splitRich(markdown);
  let last;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const send = (text: string) =>
      withRetry("send", "sendRichMessage", () =>
        api.raw.sendRichMessage({
          chat_id: chatId,
          message_thread_id: options.messageThreadId,
          rich_message: { markdown: text },
          // Reply on the first chunk, keyboard on the last.
          reply_parameters: index === 0 ? options.replyParameters : undefined,
          reply_markup: isLast ? options.replyMarkup : undefined,
          disable_notification: options.silent,
        }),
      );
    try {
      last = await send(chunk);
    } catch (error) {
      // Degenerate markdown can parse to nothing (e.g. a bare "42." reads as an
      // ordered-list item with no content). Still a rich message — just escaped.
      if (!isRichMessageEmpty(error)) throw error;
      last = await send(escapeStructure(chunk));
    }
  }
  return last;
}

function isRichMessageEmpty(error: unknown): boolean {
  return String((error as { description?: string })?.description ?? error).includes("RICH_MESSAGE_EMPTY");
}

/** Neutralize markdown structure tokens so the text renders literally. */
function escapeStructure(text: string): string {
  return text.replace(/^(\s*)(\d+)\.(\s|$)/gm, "$1$2\\.$3").replace(/^(\s*)([-*+#>])(\s|$)/gm, "$1\\$2$3");
}

/** Chat replies effectively never exceed 32k; split on paragraphs when they do. */
export function splitRich(markdown: string): string[] {
  if (markdown.length <= RICH_LIMIT) return [markdown];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of markdown.split("\n\n")) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= RICH_LIMIT) {
      current = candidate;
      continue;
    }
    // Candidate overflows: flush what we have, then place the paragraph itself —
    // hard-slicing it when even a single paragraph exceeds the limit (previously
    // an oversized paragraph following accumulated text slipped through whole).
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length > RICH_LIMIT) {
      for (let i = 0; i < paragraph.length; i += RICH_LIMIT) chunks.push(paragraph.slice(i, i + RICH_LIMIT));
    } else {
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

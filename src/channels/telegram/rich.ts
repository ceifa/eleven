import { InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup, InputRichMessageMedia, ReplyParameters } from "@grammyjs/types";
import { splitMarkdown } from "../text.ts";
import { withRetry } from "./retry.ts";

/** Bot API rich message limit is 32768; keep headroom. The slack also pays for
 * the fence markers balanceFences adds when a code block spans two chunks. */
const RICH_LIMIT = 32_000;

/** Media kinds a rich message can carry inline. Voice notes and animations have
 * no `tg://` link form, so they keep their own send methods. */
export type RichMediaKind = "photo" | "video" | "audio" | "document";

/** A local file to embed in the message body rather than send beside it. */
export interface RichMedia {
  path: string;
  kind: RichMediaKind;
}

export interface RichSendOptions {
  messageThreadId?: number;
  replyParameters?: ReplyParameters;
  replyMarkup?: InlineKeyboardMarkup;
  silent?: boolean;
  /** Files to embed at the top of the message; two or more become a collage. */
  media?: RichMedia[];
}

/** Everything but a lone media block fits one message in practice — but the
 * media is uploaded with the first message only, so callers that want it
 * embedded must know whether the text will be split. */
export function fitsOneRichMessage(markdown: string): boolean {
  return markdown.length <= RICH_LIMIT;
}

/**
 * Send agent markdown as one or more Bot API 10.1 rich messages. Rich messages
 * are eleven's only outbound text format — the agent's markdown passes through
 * as-is (native headings, tables, code, spoilers, collapsibles).
 *
 * Media travels inside the message: the files are uploaded in `media` and the
 * body opens with the blocks that reference them. That is the whole point of
 * embedding rather than captioning — a caption is capped at 1024 characters,
 * a message body is not.
 */
export async function sendRich(api: Api, chatId: number | string, markdown: string, options: RichSendOptions = {}) {
  const attachments = buildMedia(options.media);
  const chunks = splitRich(attachments ? `${attachments.blocks}\n\n${markdown}`.trim() : markdown);
  let last;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const send = (text: string) =>
      withRetry("send", "sendRichMessage", () =>
        api.raw.sendRichMessage({
          chat_id: chatId,
          message_thread_id: options.messageThreadId,
          // Uploads ride with the chunk that references them — the first one.
          rich_message: attachments && index === 0 ? { markdown: text, media: attachments.media } : { markdown: text },
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

/**
 * Turn local files into an upload list plus the markdown that references them.
 * Each file gets a `tg://<kind>?id=` link, which the API resolves against the
 * `media` array; several files in a row are wrapped in a collage so they render
 * as one grid instead of a stack.
 */
function buildMedia(files?: RichMedia[]): { blocks: string; media: InputRichMessageMedia<InputFile>[] } | undefined {
  if (!files?.length) return undefined;
  const media = files.map((file, index) => ({
    id: `m${index}`,
    media: { type: file.kind, media: new InputFile(file.path) },
  }));
  const links = files.map((file, index) => `![](tg://${file.kind}?id=m${index})`);
  const blocks = links.length === 1 ? links[0] : `<tg-collage>\n\n${links.join("\n")}\n\n</tg-collage>`;
  return { blocks, media };
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
  return splitMarkdown(markdown, RICH_LIMIT);
}

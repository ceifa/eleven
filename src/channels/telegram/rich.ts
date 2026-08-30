import { InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup, InputRichMessageMedia, ReplyParameters } from "@grammyjs/types";
import { withRetry } from "./retry.ts";
import { logger } from "../../log.ts";

const log = logger("telegram/rich");

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
  /** Deliver as an ephemeral message, visible only to this user (groups only). */
  ephemeralTo?: number;
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
  // Ephemeral delivery requires the bot to be a chat admin. Where it isn't, the
  // whole message used to be dropped — which is how /stop and /new went silent
  // in a group: they did their work, the confirmation just never arrived.
  let ephemeralTo = options.ephemeralTo;
  let last;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const send = (text: string) =>
      withRetry("send", "sendRichMessage", () =>
        api.raw.sendRichMessage({
          chat_id: chatId,
          message_thread_id: options.messageThreadId,
          ephemeral_message_parameters: ephemeralTo ? { receiver_user_id: ephemeralTo } : undefined,
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
      if (ephemeralTo !== undefined && isEphemeralRejected(error)) {
        // Ephemeral is a courtesy to the rest of the chat, not the point.
        log.warn(`ephemeral rich message rejected in chat ${chatId}, posting normally: ${error}`);
        ephemeralTo = undefined;
        last = await send(chunk);
        continue;
      }
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

/** A chat that won't take an ephemeral message — the bot is not an admin there,
 * or the chat type doesn't support one. */
function isEphemeralRejected(error: unknown): boolean {
  return /BOT_NOT_ADMIN|EPHEMERAL/i.test(String((error as { description?: string })?.description ?? error));
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
    // slicing it when even a single paragraph exceeds the limit (previously
    // an oversized paragraph following accumulated text slipped through whole).
    // Its last piece stays open as `current`, so a short tail still absorbs the
    // paragraphs that follow instead of becoming a message of its own.
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length > RICH_LIMIT) {
      const pieces = sliceParagraph(paragraph);
      chunks.push(...pieces.slice(0, -1));
      current = pieces.at(-1)!;
    } else {
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return balanceFences(chunks);
}

/**
 * Cut an oversized paragraph into limit-sized pieces. Two boundaries matter.
 * A cut must never land between the halves of a surrogate pair: `slice` counts
 * UTF-16 code units, so cutting at a fixed offset splits an emoji in half and
 * the lone surrogate left behind makes the Bot API reject the whole message.
 * And a cut should prefer the last line break in the window — landing mid-line
 * shreds tables, list items and fences far more visibly than breaking early.
 */
function sliceParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > RICH_LIMIT) {
    let cut = RICH_LIMIT;
    const lastBreak = rest.lastIndexOf("\n", cut - 1);
    if (lastBreak >= RICH_LIMIT / 2) cut = lastBreak + 1;
    // A line break is never half of a pair, so this only matters for hard cuts:
    // move the whole pair to the next piece.
    else if (isLowSurrogate(rest.charCodeAt(cut))) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** An open fenced block: the run of backticks or tildes that opened it, plus
 *  the rest of the opening line (the language hint) so it can be reopened. */
interface Fence {
  marker: string;
  info: string;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Fence state after reading `text`, starting from `open`. */
function scanFence(text: string, open: Fence | undefined): Fence | undefined {
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const [, marker, info] = match;
    // CommonMark: a closing fence repeats the opening character at least as
    // many times and carries no info string. Anything else opens a block.
    if (!open) open = { marker, info };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && !info.trim()) open = undefined;
  }
  return open;
}

/**
 * Make every chunk renderable on its own: a chunk ending inside a fenced block
 * gets the block closed, and the next chunk reopens it with the same marker and
 * language hint. Without this, splitting a long code block leaves one message
 * with an unterminated fence and the next one with orphan code.
 */
function balanceFences(chunks: string[]): string[] {
  const balanced: string[] = [];
  let open: Fence | undefined;
  for (const chunk of chunks) {
    const reopen = open;
    open = scanFence(chunk, open);
    balanced.push(`${reopen ? `${reopen.marker}${reopen.info}\n` : ""}${chunk}${open ? `\n${open.marker}` : ""}`);
  }
  return balanced;
}

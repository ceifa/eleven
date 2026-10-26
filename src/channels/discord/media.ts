import type { APIAttachment } from "discord-api-types/v10";
import { type InboundMedia, mediaNote, sanitizeNoteValue, saveInboundMedia, transcribeMedia, validMime } from "../../media-store.ts";
import { logger } from "../../log.ts";

const log = logger("discord/media");

// What a free account can send is far below this; the cap only guards the
// heap against a server with a raised upload limit.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Above this an image is referenced by path only: base64 inflates by a third,
 *  and a 20 MB photo in the request body is a provider error, not a prompt. */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 3;

/**
 * Download a message's attachments into the media store and reference them in
 * the prompt by path — the agent works on the host, so the stored path is
 * usable by its tools (and by the discord tool's `media` to send a file back).
 * Images also go to the model as images; a voice message — or any audio file —
 * also gets transcribed.
 */
export async function collectInboundMedia(attachments: APIAttachment[], transcribeCommand?: string): Promise<InboundMedia> {
  const result: InboundMedia = { notes: [], images: [] };
  for (const attachment of attachments) {
    const mime = validMime(attachment.content_type) ?? "application/octet-stream";
    const audio = mime.startsWith("audio/");
    const kind = audio ? "voice message" : mime.startsWith("image/") ? "image" : `file "${sanitizeNoteValue(attachment.filename)}"`;
    if (attachment.size > MAX_FILE_BYTES) {
      result.notes.push(`[${kind} attached but too large to download]`);
      continue;
    }
    try {
      const buffer = await download(attachment.url);
      const path = await saveInboundMedia(buffer, attachment.filename);
      result.notes.push(mediaNote(path, mime));
      if (mime.startsWith("image/") && buffer.length <= MAX_INLINE_IMAGE_BYTES) {
        result.images.push({ type: "image", data: buffer.toString("base64"), mimeType: mime });
      }
      if (!audio) continue;
      if (!transcribeCommand) {
        result.notes.push("[voice message not transcribed; transcription is not configured]");
        continue;
      }
      result.transcript = await transcribeMedia(path, transcribeCommand);
    } catch (error) {
      log.warn(`inbound ${kind} failed: ${error}`);
      result.notes.push(`[${kind} could not be processed: ${sanitizeNoteValue(String(error))}]`);
    }
  }
  return result;
}

/** Attachments live on Discord's CDN behind signed URLs — no token needed, and
 *  a GET is safe to repeat when the CDN blips. */
async function download(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(new Error(`download failed: ${response.status}`), { status: response.status });
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const status = (error as { status?: number }).status;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || attempt >= DOWNLOAD_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
    }
  }
}

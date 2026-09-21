import type { Context } from "grammy";
import { type InboundMedia, mediaNote, sanitizeNoteValue, saveInboundMedia, transcribeMedia } from "../../media-store.ts";
import { logger } from "../../log.ts";
import { withRetry } from "./retry.ts";

const log = logger("telegram/media");

/** Bot API cannot download files larger than 20 MB. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export { formatInboundBody, type InboundMedia } from "../../media-store.ts";

/**
 * Download inbound attachments into the media store and reference them in the
 * prompt as `[media attached: <path> (<mime>)]` — the agent works on the host,
 * so the stored path is directly usable by its tools (and by the telegram
 * tool's `media` parameter to send a file back). Photos additionally go to the
 * model as images; voice notes additionally get transcribed.
 */
export async function collectInboundMedia(ctx: Context, token: string, transcribeCommand?: string): Promise<InboundMedia> {
  const result: InboundMedia = { notes: [], images: [] };
  const message = ctx.message;
  if (!message) return result;

  // What we were holding when it broke: a failure note that says "voice message"
  // lets the agent ask for the right thing back instead of guessing.
  let kind = "attachment";
  try {
    if (message.photo?.length) {
      kind = "photo";
      const largest = message.photo[message.photo.length - 1];
      if ((largest.file_size ?? 0) > MAX_FILE_BYTES) {
        result.notes.push("[photo attached but too large to download]");
      } else {
        const buffer = await download(ctx, token, largest.file_id);
        result.images.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" });
        result.notes.push(mediaNote(await saveInboundMedia(buffer, "photo.jpg"), "image/jpeg"));
      }
    }

    const audio = message.voice
      ? { file: message.voice, name: "voice.oga", mime: message.voice.mime_type ?? "audio/ogg" }
      : message.audio
        ? { file: message.audio, name: message.audio.file_name ?? "audio.mp3", mime: message.audio.mime_type ?? "audio/mpeg" }
        : message.video_note
          ? { file: message.video_note, name: "video-note.mp4", mime: "video/mp4" }
          : undefined;
    if (audio) {
      kind = "voice message";
      if ((audio.file.file_size ?? 0) > MAX_FILE_BYTES) {
        result.notes.push("[voice message attached but too large to download]");
      } else {
        const buffer = await download(ctx, token, audio.file.file_id);
        const path = await saveInboundMedia(buffer, audio.name);
        result.notes.push(mediaNote(path, audio.mime));
        if (transcribeCommand) {
          result.transcript = await transcribeMedia(path, transcribeCommand);
        } else {
          result.notes.push("[voice message not transcribed; transcription is not configured]");
        }
      }
    }

    const video = message.video
      ? { file: message.video, name: message.video.file_name ?? "video.mp4", mime: message.video.mime_type ?? "video/mp4" }
      : message.animation
        ? { file: message.animation, name: message.animation.file_name ?? "animation.mp4", mime: message.animation.mime_type ?? "video/mp4" }
        : undefined;
    if (video) {
      kind = "video";
      if ((video.file.file_size ?? 0) > MAX_FILE_BYTES) {
        result.notes.push("[video attached but too large to download]");
      } else {
        const buffer = await download(ctx, token, video.file.file_id);
        result.notes.push(mediaNote(await saveInboundMedia(buffer, video.name), video.mime));
      }
    }

    if (message.document) {
      kind = "document";
      const document = message.document;
      const name = document.file_name ?? "document";
      const mime = document.mime_type ?? "application/octet-stream";
      if ((document.file_size ?? 0) > MAX_FILE_BYTES) {
        result.notes.push(`[user attached document "${sanitizeNoteValue(name)}" but it is too large to download]`);
      } else {
        const buffer = await download(ctx, token, document.file_id);
        result.notes.push(mediaNote(await saveInboundMedia(buffer, name), mime));
      }
    }
  } catch (error) {
    log.warn(`inbound ${kind} failed: ${describeError(error)}`);
    result.notes.push(`[${kind} could not be processed: ${sanitizeNoteValue(describeError(error))}]`);
  }
  return result;
}

/**
 * `${error}` on an undici failure prints the useless "TypeError: fetch failed"
 * and drops the `cause` that says whether DNS, the connection or TLS broke —
 * which is exactly what is needed to tell a blip from an outage later.
 */
function describeError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (let current: unknown = error; current && !seen.has(current); current = (current as Error).cause) {
    seen.add(current);
    parts.push(String(current));
  }
  return parts.join(": ");
}

/**
 * Download an inbound file. Both hops go through the idempotent retry: a GET
 * has no side effect to duplicate, and a single blip on Telegram's file CDN
 * used to cost the user the whole message — the agent received an error note
 * instead of the voice note, with no way to recover the audio.
 */
export async function download(ctx: Context, token: string, fileId: string): Promise<Buffer> {
  return withRetry("idempotent", "download inbound file", async () => {
    // Inside the retry: file_path comes from the same flaky network, and it is
    // valid for an hour, so re-fetching it on a second attempt is free.
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("file has no path");
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    // The status travels on the error so the retry can tell a 500 from a 404.
    if (!response.ok) throw new DownloadError(response.status);
    return Buffer.from(await response.arrayBuffer());
  });
}

/** A download that answered with a status. `transient` decides if it retries. */
class DownloadError extends Error {
  status: number;
  constructor(status: number) {
    super(`file download failed: ${status}`);
    this.status = status;
  }
}

import type { Context } from "grammy";
import type { ImageContent } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { saveInboundMedia } from "../../media-store.ts";
import { logger } from "../../log.ts";

const log = logger("telegram/media");

/** Bot API cannot download files larger than 20 MB. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface InboundMedia {
  /** Machine-generated voice transcript. */
  transcript?: string;
  /** Bracketed status notes (stored-file references, failures). */
  notes: string[];
  images: ImageContent[];
}

export function formatInboundBody(userText: string, media: InboundMedia): string {
  const { transcript, notes } = media;
  const sections: string[] = [];
  if (transcript === undefined) {
    sections.push(userText);
  } else {
    const lines = [];
    if (userText) lines.push(`[User text]\n${userText}`);
    lines.push(`[Transcript]\n${transcript}`);
    sections.push(lines.join("\n"));
  }
  sections.push(...notes);
  return sections.filter(Boolean).join("\n\n");
}

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

  try {
    if (message.photo?.length) {
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
      if ((audio.file.file_size ?? 0) > MAX_FILE_BYTES) {
        result.notes.push("[voice message attached but too large to download]");
      } else {
        const buffer = await download(ctx, token, audio.file.file_id);
        const path = await saveInboundMedia(buffer, audio.name);
        result.notes.push(mediaNote(path, audio.mime));
        if (transcribeCommand) {
          result.transcript = await transcribe(path, transcribeCommand);
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
      if ((video.file.file_size ?? 0) > MAX_FILE_BYTES) {
        result.notes.push("[video attached but too large to download]");
      } else {
        const buffer = await download(ctx, token, video.file.file_id);
        result.notes.push(mediaNote(await saveInboundMedia(buffer, video.name), video.mime));
      }
    }

    if (message.document) {
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
    log.warn(`inbound media failed: ${error}`);
    result.notes.push(`[attachment could not be processed: ${error}]`);
  }
  return result;
}

function mediaNote(path: string, mime: string): string {
  return `[media attached: ${path} (${sanitizeNoteValue(mime)})]`;
}

/** External strings (filenames, mime types) get control chars and `]` stripped
 * so they can't break out of a bracketed prompt note. Stored paths are already
 * safe — the media store generates them. */
function sanitizeNoteValue(value: string): string {
  return value.replaceAll(/[\p{Cc}\]]+/gu, " ").replaceAll(/\s+/g, " ").trim();
}

async function download(ctx: Context, token: string, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("file has no path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`file download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Run the configured transcription command ({{file}} placeholder) on a stored audio file. */
async function transcribe(path: string, command: string): Promise<string> {
  const rendered = command.replaceAll("{{file}}", path);
  return await new Promise<string>((resolve, reject) => {
    execFile("bash", ["-c", rendered], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim() || "(empty transcript)");
    });
  });
}

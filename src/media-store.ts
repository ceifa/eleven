import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MEDIA_DIR } from "./paths.ts";
import { logger } from "./log.ts";

const log = logger("media-store");

/**
 * Persist an inbound attachment and return its absolute path. The path goes
 * into the agent's prompt (and through the transcription shell command), so
 * the stored name is restricted to shell- and prompt-safe characters.
 */
export async function saveInboundMedia(buffer: Buffer, filename: string): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const path = join(MEDIA_DIR, `${randomUUID().slice(0, 8)}-${safeFilename(filename)}`);
  await writeFile(path, buffer);
  return path;
}

/** Delete stored media older than the retention window (mtime-based, best-effort). */
export async function sweepMedia(retentionMs: number): Promise<number> {
  const cutoff = Date.now() - retentionMs;
  let entries;
  try {
    entries = await readdir(MEDIA_DIR, { withFileTypes: true });
  } catch {
    return 0; // directory does not exist yet
  }
  const results = await Promise.allSettled(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(MEDIA_DIR, entry.name))
      .map(async (file) => {
        if ((await stat(file)).mtimeMs >= cutoff) return 0;
        await rm(file, { force: true });
        return 1;
      }),
  );
  const removed = results.reduce((total, r) => total + (r.status === "fulfilled" ? r.value : 0), 0);
  if (removed) log.info(`removed ${removed} media file(s) past retention`);
  return removed;
}

/**
 * Delete every stored media file a session transcript references. Media is tied
 * to a thread only through the prompt — saveInboundMedia paths end up verbatim
 * in the session JSONL — so scanning the transcript is the reverse index.
 */
export async function deleteReferencedMedia(sessionFile: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch {
    return 0; // no session file — nothing referenced
  }
  // Stored names are shell-safe (uuid prefix + safeFilename), so they never
  // contain JSON escapes and a plain text match finds every reference.
  const dir = MEDIA_DIR.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const files = new Set(raw.match(new RegExp(`${dir}/[\\w.-]+`, "g")) ?? []);
  const results = await Promise.allSettled([...files].map((file) => rm(file, { force: true })));
  const removed = results.filter((r) => r.status === "fulfilled").length;
  if (removed) log.info(`removed ${removed} media file(s) of deleted session`);
  return removed;
}

function safeFilename(filename: string): string {
  return basename(filename).replaceAll(/[^\w.-]/g, "_").slice(0, 80) || "attachment";
}

/* ---------- how an attachment enters a prompt ---------- */

/** Attachments as a turn carries them: what the agent is told about them, what
 *  a voice note said, and what the model additionally sees as an image. */
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

/** How a stored attachment is named to the agent: an absolute path its tools can
 *  open directly (and hand back to a channel's `media` parameter). */
export function mediaNote(path: string, mime: string): string {
  return `[media attached: ${path} (${sanitizeNoteValue(mime)})]`;
}

/** External strings (filenames, mime types) get control chars and `]` stripped
 * so they can't break out of a bracketed prompt note. Stored paths are already
 * safe — the media store generates them. */
export function sanitizeNoteValue(value: string): string {
  return value.replaceAll(/[\p{Cc}\]]+/gu, " ").replaceAll(/\s+/g, " ").trim();
}

/** Run the configured transcription command ({{file}} placeholder) on a stored audio file. */
export async function transcribeMedia(path: string, command: string): Promise<string> {
  const rendered = command.replaceAll("{{file}}", path);
  return await new Promise<string>((resolve, reject) => {
    execFile("bash", ["-c", rendered], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim() || "(empty transcript)");
    });
  });
}

/* ---------- attachments referenced by id (the dashboard's upload flow) ---------- */

/** An upload the client holds a receipt for. The id is the stored file's name —
 *  everything else is descriptive, and never trusted with more than a note. */
export interface StoredAttachment {
  id: string;
  /** Declared at upload time; only ever sanitized into prose or matched against
   *  `image/`, so a lying client gets nothing a same-origin page couldn't do. */
  mime?: string;
  /** A recording rather than a file — gets transcribed, like a Telegram voice note. */
  voice?: boolean;
}

/** The absolute path of a stored media id, or undefined when the id is not one.
 *  Ids are bare filenames: anything with a separator, or the `..` entry itself,
 *  is refused before it can be joined onto the media directory. */
export function resolveMediaPath(id: string): string | undefined {
  if (!/^[\w.-]+$/.test(id) || id.startsWith(".")) return undefined;
  return join(MEDIA_DIR, id);
}

/** Above this an image is referenced by path only: base64 inflates by a third,
 *  and a 20 MB photo in the request body is a provider error, not a prompt. */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Turn upload receipts into the same shape an inbound Telegram message produces:
 * a note per file so the agent can open it, images additionally handed to the
 * model, and recordings additionally transcribed.
 */
export async function collectStoredMedia(attachments: StoredAttachment[], transcribeCommand?: string): Promise<InboundMedia> {
  const result: InboundMedia = { notes: [], images: [] };
  for (const attachment of attachments) {
    const path = resolveMediaPath(attachment.id);
    let size: number | undefined;
    try {
      size = path ? (await stat(path)).size : undefined;
    } catch {
      size = undefined;
    }
    if (!path || size === undefined) {
      result.notes.push("[an attachment was referenced but is no longer stored]");
      continue;
    }
    const mime = validMime(attachment.mime) ?? "application/octet-stream";
    result.notes.push(mediaNote(path, mime));
    if (mime.startsWith("image/") && size <= MAX_INLINE_IMAGE_BYTES) {
      result.images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType: mime });
    }
    if (!attachment.voice) continue;
    if (!transcribeCommand) {
      result.notes.push("[voice message not transcribed; transcription is not configured]");
      continue;
    }
    try {
      result.transcript = await transcribeMedia(path, transcribeCommand);
    } catch (error) {
      log.warn(`transcription failed: ${error}`);
      result.notes.push("[voice message could not be transcribed]");
    }
  }
  return result;
}

/** A media type that is actually a media type. Anything else is dropped rather
 *  than repeated back, so a header can't smuggle a sentence into the prompt. */
export function validMime(value: string | undefined): string | undefined {
  const mime = value?.split(";", 1)[0].trim().toLowerCase();
  return mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : undefined;
}

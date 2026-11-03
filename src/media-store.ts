import { existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MEDIA_DIR } from "./paths.ts";
import { logger } from "./log.ts";

const log = logger("media-store");

const SCAN_CHUNK_BYTES = 256 * 1024;

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
  let files: Set<string>;
  try {
    files = await referencedMedia(sessionFile);
  } catch {
    return 0; // no session file — nothing referenced
  }
  const results = await Promise.allSettled([...files].map((file) => rm(file, { force: true })));
  const removed = results.filter((r) => r.status === "fulfilled").length;
  if (removed) log.info(`removed ${removed} media file(s) of deleted session`);
  return removed;
}

/** A transcript can run to hundreds of megabytes of screenshots, so it is
 * scanned in chunks that overlap by more than any stored path is long. */
async function referencedMedia(sessionFile: string): Promise<Set<string>> {
  // Stored names are shell-safe (uuid prefix + safeFilename), so they never
  // contain JSON escapes and a plain text match finds every reference.
  const dir = MEDIA_DIR.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${dir}/[\\w.-]+`, "g");
  const overlap = MEDIA_DIR.length + 128;
  const files = new Set<string>();
  const handle = await open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let text = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, SCAN_CHUNK_BYTES);
      text += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
      for (const match of text.matchAll(pattern)) {
        // One running into the chunk's end may go on; the overlap reads it again whole.
        if (bytesRead && match.index + match[0].length === text.length) continue;
        files.add(match[0]);
      }
      if (!bytesRead) return files;
      text = text.slice(-overlap);
    }
  } finally {
    await handle.close();
  }
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

/**
 * Flatten a segmented transcript into one line.
 *
 * Speech-to-text backends emit one line per segment, and some of them (notably
 * whisper.cpp's `whisper-server`, which wraps segments at 60 characters) cut a
 * line in the middle of a word — joining those on the newline is what turns
 * "adicionada" into "ad icionada" in the agent's prompt. Whisper's own spacing
 * says where the words are: a segment that begins a new word starts with a
 * space, one that continues the previous word does not. Join on that signal.
 */
export function flattenTranscript(text: string): string {
  let out = "";
  for (const segment of text.split("\n")) {
    if (!segment.trim()) continue; // blank segments must not strand a separator
    if (out && /^\s/.test(segment)) out += " ";
    out += segment.trim().replaceAll(/\s+/g, " ");
  }
  return out;
}

/** Run the configured transcription command ({{file}} placeholder) on a stored audio file. */
export async function transcribeMedia(path: string, command: string): Promise<string> {
  const rendered = command.replaceAll("{{file}}", path);
  return await new Promise<string>((resolve, reject) => {
    execFile("bash", ["-c", rendered], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(flattenTranscript(stdout) || "(empty transcript)");
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

/* ---------- images a transcript holds by reference ---------- */

/** An image block whose bytes live in the media store: `data` stays empty on
 *  disk and in memory, and is read back only for the request that sends it.
 *  The absolute path is what deleteReferencedMedia finds in the transcript. */
interface StoredImage extends ImageContent {
  path: string;
}

type Block = TextContent | ImageContent;

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const isStored = (block: Block): block is StoredImage => block.type === "image" && !block.data && typeof (block as StoredImage).path === "string";

function blocksOf(message: AgentMessage): Block[] | undefined {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Block[]) : undefined;
}

/** Image data a thread has in hand, by stored path and by the data itself, so
 *  its requests neither re-read a file nor log the base64 of one. */
export class LoadedImages {
  private byPath = new Map<string, string>();
  private byData = new Map<string, string>();

  set(path: string, data: string): void {
    this.byPath.set(path, data);
    this.byData.set(data, path);
  }

  get size(): number {
    return this.byPath.size;
  }

  data(path: string): string | undefined {
    return this.byPath.get(path);
  }

  /** Where an image sent as `data` (bare base64 or a data URL) is stored. */
  path(data: string): string | undefined {
    return this.byData.get(data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data);
  }

  clear(): void {
    this.byPath.clear();
    this.byData.clear();
  }
}

/**
 * The message with its inline images moved to the media store, or undefined
 * when it has none. Files are named by owner (deleting a thread deletes what
 * its transcript references) and content. Synchronous so transcript order
 * holds wherever it is called from.
 */
export function storeImages<T extends AgentMessage>(message: T, loaded: LoadedImages, owner: string): T | undefined {
  const blocks = blocksOf(message);
  if (!blocks?.some((block) => block.type === "image" && block.data)) return undefined;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const content = blocks.map((block): Block => {
    if (block.type !== "image" || !block.data) return block;
    const bytes = Buffer.from(block.data, "base64");
    // Anything that is not canonical base64 would not come back byte for byte.
    if (bytes.toString("base64") !== block.data) return block;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = join(MEDIA_DIR, `${owner.replaceAll(/[^\w-]/g, "_")}-${hash}.${IMAGE_EXTENSIONS[block.mimeType] ?? "bin"}`);
    if (existsSync(path)) {
      // Media retention runs on mtime.
      const now = new Date();
      utimesSync(path, now, now);
    } else {
      writeFileSync(`${path}.tmp`, bytes);
      renameSync(`${path}.tmp`, path);
    }
    loaded.set(path, block.data);
    const stored: StoredImage = { type: "image", data: "", mimeType: block.mimeType, path };
    return stored;
  });
  return { ...message, content };
}

/** The messages with every stored image read back in. One the media store no
 *  longer has becomes a note, so the request still goes out. */
export async function loadImages(messages: AgentMessage[], loaded: LoadedImages): Promise<AgentMessage[]> {
  if (!messages.some((message) => blocksOf(message)?.some(isStored))) return messages;
  return await Promise.all(messages.map(async (message) => {
    const blocks = blocksOf(message);
    if (!blocks?.some(isStored)) return message;
    const content = await Promise.all(blocks.map(async (block): Promise<Block> => {
      if (!isStored(block)) return block;
      let data = loaded.data(block.path);
      if (data === undefined) {
        try {
          data = (await readFile(block.path)).toString("base64");
        } catch {
          return { type: "text", text: `[image no longer stored: ${block.path}]` };
        }
        loaded.set(block.path, data);
        // Media retention runs on mtime: an image a thread still sends stays.
        const now = new Date();
        await utimes(block.path, now, now).catch(() => {});
      }
      return { type: "image", data, mimeType: block.mimeType };
    }));
    return { ...message, content } as AgentMessage;
  }));
}

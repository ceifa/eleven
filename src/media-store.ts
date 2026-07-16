import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
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

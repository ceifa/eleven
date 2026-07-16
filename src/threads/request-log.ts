import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { REQUESTS_DIR } from "../paths.ts";
import { keyedLane, lruTouch, readFileSlice } from "../util.ts";
import { logger } from "../log.ts";

const log = logger("threads/request-log");

/** What the dashboard lists per request; the payload stays on disk until asked for. */
export interface ProviderRequestMeta {
  id: string;
  at: number;
  model: string;
  bytes: number;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INDEXED_THREADS = 64;
const NEWLINE = Buffer.from("\n");

/** Where a thread's provider-request log lives (gc deletes these with the thread). */
export function requestLogFile(threadId: string): string {
  return join(REQUESTS_DIR, `${threadId.replaceAll("/", "_")}.jsonl`);
}

/** Meta plus where the line sits in the file, so get() can read just that slice. */
interface IndexedMeta extends ProviderRequestMeta {
  offset: number;
}

interface ThreadIndex {
  entries: IndexedMeta[];
  /** Current file size in bytes — trim decisions never need a stat. */
  bytes: number;
}

/**
 * The exact payloads eleven's agent sent to AI providers, one JSONL file per
 * thread, captured via pi's `before_provider_request` extension event. Oldest
 * entries are trimmed when a thread's file outgrows MAX_FILE_BYTES.
 *
 * record() fires on the model-call hot path, so all file work happens on an
 * async per-thread lane; an in-memory index (id/model/offset per line) keeps
 * list() and get() from re-reading whole files.
 */
export class RequestLog {
  private index = new Map<string, ThreadIndex>();
  private lanes = new Map<string, Promise<unknown>>();
  private dirReady: Promise<unknown> | undefined;

  record(threadId: string, model: string, payload: unknown): ProviderRequestMeta {
    const meta: ProviderRequestMeta = { id: randomUUID().slice(0, 8), at: Date.now(), model, bytes: 0 };
    // Stringify now — pi may reuse the payload object after the hook returns.
    const line = JSON.stringify({ id: meta.id, at: meta.at, model, payload }) + "\n";
    const lineBytes = Buffer.byteLength(line);
    meta.bytes = lineBytes - 1; // sans trailing newline
    void keyedLane(this.lanes, threadId, async () => {
      const index = await this.load(threadId);
      this.dirReady ??= mkdir(REQUESTS_DIR, { recursive: true });
      await this.dirReady;
      await appendFile(requestLogFile(threadId), line);
      index.entries.push({ ...meta, offset: index.bytes });
      index.bytes += lineBytes;
      if (index.bytes > MAX_FILE_BYTES) await this.trim(threadId, index);
    }).catch((error) => log.warn(`record failed for ${threadId}: ${error}`));
    return meta;
  }

  async list(threadId: string): Promise<ProviderRequestMeta[]> {
    // A built index can be snapshotted directly — no need to wait behind writes.
    const index =
      lruTouch(this.index, threadId) ??
      (await keyedLane(this.lanes, threadId, () => this.load(threadId)).catch((error) => {
        log.warn(`list failed for ${threadId}: ${error}`);
        return { entries: [] as IndexedMeta[], bytes: 0 };
      }));
    return index.entries.map(({ id, at, model, bytes }) => ({ id, at, model, bytes }));
  }

  async get(threadId: string, id: string): Promise<unknown | undefined> {
    // Serialized with record/trim — offsets are only valid between rewrites.
    return keyedLane(this.lanes, threadId, async () => {
      const meta = (await this.load(threadId)).entries.find((e) => e.id === id);
      if (!meta) return undefined;
      const line = await readFileSlice(requestLogFile(threadId), meta.offset, meta.bytes);
      return JSON.parse(line.toString("utf8")) as unknown;
    }).catch((error) => {
      log.warn(`get failed for ${threadId}: ${error}`);
      return undefined;
    });
  }

  /** Delete a thread's request log — the file and its in-memory index. */
  async delete(threadId: string): Promise<void> {
    // On the lane so an in-flight record() can't re-create the file mid-delete.
    await keyedLane(this.lanes, threadId, async () => {
      this.index.delete(threadId);
      await rm(requestLogFile(threadId), { force: true });
    }).catch((error) => log.warn(`delete failed for ${threadId}: ${error}`));
  }

  /** In-memory index for a thread, built from disk once and LRU-capped. */
  private async load(threadId: string): Promise<ThreadIndex> {
    const cached = lruTouch(this.index, threadId);
    if (cached) return cached;
    const index: ThreadIndex = { entries: [], bytes: 0 };
    try {
      const raw = await readFile(requestLogFile(threadId));
      let start = 0;
      while (start < raw.length) {
        let end = raw.indexOf(0x0a, start);
        if (end === -1) end = raw.length;
        if (end > start) {
          try {
            const { id, at, model } = JSON.parse(raw.toString("utf8", start, end)) as ProviderRequestMeta;
            index.entries.push({ id, at, model, bytes: end - start, offset: start });
          } catch {
            // skip malformed lines
          }
        }
        start = end + 1;
      }
      index.bytes = raw.length;
    } catch {
      // no file yet
    }
    this.index.set(threadId, index);
    if (this.index.size > MAX_INDEXED_THREADS) {
      this.index.delete(this.index.keys().next().value!);
    }
    return index;
  }

  /** Drop the oldest half of the entries, rebuilding the file from the kept ones. */
  private async trim(threadId: string, index: ThreadIndex) {
    // floor, not ceil: with a single (oversized) entry, ceil(1/2)=1 → keep none,
    // wiping the entry that was just written. floor keeps it; there's nothing
    // older to drop, so trim is a no-op until a second entry arrives.
    const keep = index.entries.slice(Math.floor(index.entries.length / 2));
    if (keep.length === index.entries.length) return; // nothing to drop
    const file = requestLogFile(threadId);
    // Copy each kept entry by its own offset and re-pack contiguously. A raw
    // tail slice would preserve any junk between lines (e.g. a crash-truncated
    // partial line load() skipped) while the recomputed offsets assume none,
    // drifting get() reads out of alignment.
    const raw = await readFile(file);
    const parts: Buffer[] = [];
    let offset = 0;
    const repacked = keep.map((entry) => {
      parts.push(raw.subarray(entry.offset, entry.offset + entry.bytes), NEWLINE);
      const moved = { ...entry, offset };
      offset += entry.bytes + 1;
      return moved;
    });
    await writeFile(file, Buffer.concat(parts));
    index.entries = repacked;
    index.bytes = offset;
  }
}

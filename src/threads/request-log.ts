import { appendFile, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
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
const CLOSING_BRACE = 0x7d;
const CHUNK_BYTES = 256 * 1024;
/** record() writes the meta ahead of the payload, so this much of a line holds it. */
const META_BYTES = 1024;
const META = /^\{"id":("(?:[^"\\]|\\.)*"),"at":(\d+),"model":("(?:[^"\\]|\\.)*")/;

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
 * Provider request payloads, one JSONL file per thread, captured via Pi's
 * `before_provider_request` event. Nested runtimes record their logical SDK
 * invocation because their private wire payload is intentionally unavailable. Oldest
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
    let index: ThreadIndex = { entries: [], bytes: 0 };
    try {
      const handle = await open(requestLogFile(threadId), "r");
      try {
        index = await indexLines(handle);
      } finally {
        await handle.close();
      }
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
    // Still .jsonl, so gc sweeps one a crash left behind.
    const packed = file.replace(/\.jsonl$/, ".trim.jsonl");
    // Copy each kept entry by its own offset and re-pack contiguously. A raw
    // tail slice would preserve any junk between lines (e.g. a crash-truncated
    // partial line load() skipped) while the recomputed offsets assume none,
    // drifting get() reads out of alignment. Copied through a fixed buffer: the
    // kept entries can be far larger than the file cap.
    const source = await open(file, "r");
    const target = await open(packed, "w");
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    const repacked: IndexedMeta[] = [];
    try {
      for (const entry of keep) {
        for (let copied = 0; copied < entry.bytes;) {
          const { bytesRead } = await source.read(chunk, 0, Math.min(CHUNK_BYTES, entry.bytes - copied), entry.offset + copied);
          if (!bytesRead) throw new Error(`${file} shrank while trimming`);
          await target.write(chunk, 0, bytesRead);
          copied += bytesRead;
        }
        await target.write(NEWLINE);
        repacked.push({ ...entry, offset });
        offset += entry.bytes + 1;
      }
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
    await rename(packed, file);
    index.entries = repacked;
    index.bytes = offset;
  }
}

/** A payload can run to tens of megabytes, so the log is streamed and each
 * line is read only as far as the meta record() writes ahead of it. */
async function indexLines(handle: FileHandle): Promise<ThreadIndex> {
  const index: ThreadIndex = { entries: [], bytes: 0 };
  // A line cut short by a crash ends anywhere but the payload's closing brace.
  const addLine = (head: Buffer, offset: number, bytes: number, last: number | undefined) => {
    const meta = last === CLOSING_BRACE && META.exec(head.toString("utf8"));
    // skip malformed lines
    if (meta) index.entries.push({ id: JSON.parse(meta[1]), at: Number(meta[2]), model: JSON.parse(meta[3]), bytes, offset });
  };
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let lineStart = 0;
  let head = Buffer.alloc(0);
  let last: number | undefined;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, index.bytes);
    if (!bytesRead) break;
    const raw = chunk.subarray(0, bytesRead);
    let from = 0;
    for (;;) {
      const newline = raw.indexOf(0x0a, from);
      const end = newline === -1 ? raw.length : newline;
      if (head.length < META_BYTES) {
        const piece = raw.subarray(from, Math.min(end, from + META_BYTES - head.length));
        head = head.length ? Buffer.concat([head, piece]) : piece;
      }
      if (newline === -1) break;
      const lineEnd = index.bytes + newline;
      if (lineEnd > lineStart) addLine(head, lineStart, lineEnd - lineStart, newline ? raw[newline - 1] : last);
      lineStart = lineEnd + 1;
      head = Buffer.alloc(0);
      from = newline + 1;
    }
    // `chunk` is reused by the next read; a head spanning reads needs its own copy.
    head = Buffer.from(head);
    last = raw[bytesRead - 1];
    index.bytes += bytesRead;
  }
  if (index.bytes > lineStart) addLine(head, lineStart, index.bytes - lineStart, last);
  return index;
}

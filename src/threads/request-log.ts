import { appendFile, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { hash, randomUUID } from "node:crypto";
import { REQUESTS_DIR } from "../paths.ts";
import { keyedLane, lruTouch, readFileSlice } from "../util.ts";
import type { LoadedImages } from "../media-store.ts";
import { logger } from "../log.ts";

const log = logger("threads/request-log");

/** What the dashboard lists per request; the payload stays on disk until asked for. */
export interface ProviderRequestMeta {
  id: string;
  at: number;
  model: string;
  /** Size of the whole payload, however little of it the log had to write. */
  bytes: number;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INDEXED_THREADS = 64;
/** Deltas in a row before a full payload again, which bounds what get() reads. */
const MAX_CHAIN = 100;
const NEWLINE = Buffer.from("\n");
const CLOSING_BRACE = 0x7d;
const CHUNK_BYTES = 256 * 1024;
/** record() writes the meta ahead of the payload, so this much of a line holds it. */
const META_BYTES = 1024;
const JSON_STRING = String.raw`("(?:[^"\\]|\\.)*")`;
const META = new RegExp(String.raw`^\{"id":${JSON_STRING},"at":(\d+),"model":${JSON_STRING}(?:,"bytes":(\d+))?(?:,"base":${JSON_STRING})?`);
/** Shorter strings are never image data, and skip the lookup. */
const MIN_IMAGE_CHARS = 1024;

/** Where a thread's provider-request log lives (gc deletes these with the thread). */
export function requestLogFile(threadId: string): string {
  return join(REQUESTS_DIR, `${threadId.replaceAll("/", "_")}.jsonl`);
}

/** Meta plus where the line sits in the file, so get() can read just that slice. */
interface IndexedMeta extends ProviderRequestMeta {
  offset: number;
  length: number;
  /** The request this one's delta applies to; absent on a full payload. */
  base?: string;
}

interface ThreadIndex {
  entries: IndexedMeta[];
  /** Current file size in bytes — trim decisions never need a stat. */
  bytes: number;
}

/** A top-level payload value's JSON; an array's, element by element. */
type Parts = [key: string, json: string | string[]][];
/** The same, hashed: what a later request is compared against. */
type Shape = Map<string, string | string[]>;

/** A delta: top-level values replaced, arrays cut at an index and continued, keys gone. */
interface Delta {
  set: Record<string, unknown>;
  splice: Record<string, [from: number, items: unknown[]]>;
  drop: string[];
}

/** The last request record() wrote for a thread, which its next one can build on. */
interface LastRequest {
  id: string;
  shape: Shape;
  /** Deltas since the last full payload, and their bytes. */
  chain: number;
  chainBytes: number;
}

/**
 * Provider request payloads, one JSONL file per thread, captured via Pi's
 * `before_provider_request` event. Nested runtimes record their logical SDK
 * invocation because their private wire payload is intentionally unavailable.
 *
 * Each request repeats the conversation before it, so most lines are a delta
 * on the previous one, and images the thread stores are logged as their path.
 * Oldest entries are trimmed when a thread's file outgrows MAX_FILE_BYTES.
 *
 * record() fires on the model-call hot path, so all file work happens on an
 * async per-thread lane; an in-memory index (id/model/offset per line) keeps
 * list() and get() from re-reading whole files.
 */
export class RequestLog {
  private index = new Map<string, ThreadIndex>();
  private last = new Map<string, LastRequest>();
  private lanes = new Map<string, Promise<unknown>>();
  private dirReady: Promise<unknown> | undefined;

  record(threadId: string, model: string, payload: unknown, images?: LoadedImages): ProviderRequestMeta {
    const meta: ProviderRequestMeta = { id: randomUUID().slice(0, 8), at: Date.now(), model, bytes: 0 };
    // Serialize now — pi may reuse the payload object after the hook returns.
    const replacer = images?.size ? (_key: string, value: unknown) => {
      if (typeof value !== "string" || value.length < MIN_IMAGE_CHARS) return value;
      const path = images.path(value);
      return path ? `[image: ${path}]` : value;
    } : undefined;
    const parts = partsOf(payload, replacer);
    const whole = parts ? undefined : JSON.stringify(payload, replacer) ?? "null";
    meta.bytes = parts ? partsBytes(parts) : Buffer.byteLength(whole!);
    const shape = parts && shapeOf(parts);
    const last = lruTouch(this.last, threadId);
    const delta = shape && last && deltaJson(last.shape, parts, shape);
    const builds = delta && last.chain < MAX_CHAIN && last.chainBytes + delta.length <= MAX_FILE_BYTES / 2 && delta.length * 2 < meta.bytes;
    const base = builds ? last.id : undefined;
    const body = builds ? `"base":${JSON.stringify(base)},"delta":${delta}` : `"payload":${whole ?? objectJson(parts!)}`;
    if (shape) this.last.set(threadId, { id: meta.id, shape, chain: builds ? last.chain + 1 : 0, chainBytes: builds ? last.chainBytes + delta.length : 0 });
    else this.last.delete(threadId);
    if (this.last.size > MAX_INDEXED_THREADS) this.last.delete(this.last.keys().next().value!);
    const line = `{"id":${JSON.stringify(meta.id)},"at":${meta.at},"model":${JSON.stringify(model)},"bytes":${meta.bytes},${body}}\n`;
    const lineBytes = Buffer.byteLength(line);
    void keyedLane(this.lanes, threadId, async () => {
      const index = await this.load(threadId);
      this.dirReady ??= mkdir(REQUESTS_DIR, { recursive: true });
      await this.dirReady;
      await appendFile(requestLogFile(threadId), line);
      index.entries.push({ ...meta, offset: index.bytes, length: lineBytes - 1, base });
      index.bytes += lineBytes;
      if (index.bytes > MAX_FILE_BYTES) await this.trim(threadId, index);
    }).catch((error) => {
      // What the next request would build on may not be on disk.
      this.last.delete(threadId);
      log.warn(`record failed for ${threadId}: ${error}`);
    });
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

  /** A request as it was sent: its full payload, rebuilt from the deltas when it is one. */
  async get(threadId: string, id: string): Promise<unknown | undefined> {
    // Serialized with record/trim — offsets are only valid between rewrites.
    return keyedLane(this.lanes, threadId, async () => {
      const { entries } = await this.load(threadId);
      const at = entries.findIndex((e) => e.id === id);
      if (at === -1) return undefined;
      let start = at;
      for (; entries[start].base; start--) {
        if (entries[start - 1]?.id !== entries[start].base) throw new Error(`request ${id} lost the request it builds on`);
      }
      // The chain is contiguous on disk: one read covers it.
      const from = entries[start].offset;
      const raw = await readFileSlice(requestLogFile(threadId), from, entries[at].offset + entries[at].length - from);
      const read = (entry: IndexedMeta) => JSON.parse(raw.toString("utf8", entry.offset - from, entry.offset - from + entry.length));
      const { payload } = read(entries[start]);
      for (const entry of entries.slice(start + 1, at + 1)) applyDelta(payload, read(entry).delta);
      return { id, at: entries[at].at, model: entries[at].model, payload };
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
      this.last.delete(threadId);
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

  /** Keep about the newest half of the file, cut where a full payload starts: every delta after it needs it. */
  private async trim(threadId: string, index: ThreadIndex) {
    const fits = index.entries.findIndex((e) => !e.base && index.bytes - e.offset <= MAX_FILE_BYTES / 2);
    const start = fits === -1 ? index.entries.findLastIndex((e) => !e.base) : fits;
    if (start <= 0) return; // nothing to drop
    const keep = index.entries.slice(start);
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
        for (let copied = 0; copied < entry.length;) {
          const { bytesRead } = await source.read(chunk, 0, Math.min(CHUNK_BYTES, entry.length - copied), entry.offset + copied);
          if (!bytesRead) throw new Error(`${file} shrank while trimming`);
          await target.write(chunk, 0, bytesRead);
          copied += bytesRead;
        }
        await target.write(NEWLINE);
        repacked.push({ ...entry, offset });
        offset += entry.length + 1;
      }
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
    await rename(packed, file);
    index.entries = repacked;
    index.bytes = offset;
  }
}

/** A plain-object payload serialized value by value, or undefined for any other kind. */
function partsOf(payload: unknown, replacer: ((key: string, value: unknown) => unknown) | undefined): Parts | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const parts: Parts = [];
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      parts.push([key, value.map((item) => JSON.stringify(item, replacer) ?? "null")]);
      continue;
    }
    // undefined, functions and symbols: keys JSON.stringify would leave out.
    const json = JSON.stringify(value, replacer);
    if (json !== undefined) parts.push([key, json]);
  }
  return parts;
}

const valueJson = (json: string | string[]) => (typeof json === "string" ? json : `[${json.join(",")}]`);

/** Bytes of objectJson(parts), without building it. */
function partsBytes(parts: Parts): number {
  let bytes = 2 + Math.max(parts.length - 1, 0); // braces and commas
  for (const [key, json] of parts) {
    bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
    bytes += typeof json === "string" ? Buffer.byteLength(json) : json.reduce((sum, item) => sum + Buffer.byteLength(item) + 1, json.length ? 1 : 2);
  }
  return bytes;
}

/** Exactly what JSON.stringify gives for the payload the parts came from. */
const objectJson = (parts: Parts) => `{${parts.map(([key, json]) => `${JSON.stringify(key)}:${valueJson(json)}`).join(",")}}`;

const digest = (json: string) => hash("sha1", json);

function shapeOf(parts: Parts): Shape {
  return new Map(parts.map(([key, json]) => [key, typeof json === "string" ? digest(json) : json.map(digest)]));
}

/** The JSON of a Delta from the previous request's shape to this one. */
function deltaJson(previous: Shape, parts: Parts, shape: Shape): string {
  const set: string[] = [];
  const splice: string[] = [];
  for (const [key, json] of parts) {
    const before = previous.get(key);
    const now = shape.get(key)!;
    const name = JSON.stringify(key);
    if (typeof json === "string" || !Array.isArray(before)) {
      if (before !== now) set.push(`${name}:${valueJson(json)}`);
      continue;
    }
    let common = 0;
    while (common < before.length && common < now.length && before[common] === now[common]) common++;
    if (common < before.length || common < now.length) splice.push(`${name}:[${common},[${json.slice(common).join(",")}]]`);
  }
  const drop = [...previous.keys()].filter((key) => !shape.has(key));
  return `{"set":{${set.join(",")}},"splice":{${splice.join(",")}},"drop":${JSON.stringify(drop)}}`;
}

function applyDelta(payload: Record<string, unknown>, delta: Delta): void {
  for (const key of delta.drop) delete payload[key];
  Object.assign(payload, delta.set);
  for (const [key, [from, items]] of Object.entries(delta.splice)) payload[key] = [...(payload[key] as unknown[]).slice(0, from), ...items];
}

/** A payload can run to tens of megabytes, so the log is streamed and each
 * line is read only as far as the meta record() writes ahead of it. */
async function indexLines(handle: FileHandle): Promise<ThreadIndex> {
  const index: ThreadIndex = { entries: [], bytes: 0 };
  // A line cut short by a crash ends anywhere but the payload's closing brace.
  const addLine = (head: Buffer, offset: number, length: number, last: number | undefined) => {
    const meta = last === CLOSING_BRACE && META.exec(head.toString("utf8"));
    // skip malformed lines
    if (!meta) return;
    const entry: IndexedMeta = { id: JSON.parse(meta[1]), at: Number(meta[2]), model: JSON.parse(meta[3]), bytes: meta[4] ? Number(meta[4]) : length, offset, length };
    if (meta[5]) entry.base = JSON.parse(meta[5]);
    index.entries.push(entry);
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

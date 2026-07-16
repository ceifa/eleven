import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** Read a JSON state file, returning `fallback` when missing or unparsable. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write a JSON state file atomically (tmp + rename), creating parent dirs. */
export function writeJsonFile(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

const PERSIST_DELAY_MS = 500;

/**
 * Debounced persistence for state files touched on the message hot path: a
 * burst of updates costs one write, at most PERSIST_DELAY_MS after the first.
 * Flushes on process exit; a hard kill loses at most half a second of state.
 */
export function debouncedWriter(write: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    write();
  };
  process.on("exit", flush);
  return () => {
    if (timer) return; // a write is already scheduled; it will pick up this change
    timer = setTimeout(() => {
      timer = undefined;
      write();
    }, PERSIST_DELAY_MS);
    timer.unref();
  };
}

/**
 * Chain `op` onto a keyed promise lane so ops on the same key never overlap,
 * cleaning up the map entry once the lane drains. Rejections propagate to the
 * caller of `op` but never poison the lane for the next op.
 */
export function keyedLane<T>(lanes: Map<string, Promise<unknown>>, key: string, op: () => Promise<T>): Promise<T> {
  const lane = (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(op);
  lanes.set(key, lane);
  void lane.catch(() => {}).finally(() => {
    if (lanes.get(key) === lane) lanes.delete(key);
  });
  return lane;
}

/** Mark `key` most-recently-used (Maps iterate in insertion order, so the
 * oldest entry is always `map.keys().next().value`). */
export function lruTouch<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

/** Read `length` bytes at `offset`; shorter if the file shrank meanwhile. */
export async function readFileSlice(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    // allocUnsafe: every byte is either overwritten by read() or cut by subarray.
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Concatenated text blocks of a pi message content array. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("");
}

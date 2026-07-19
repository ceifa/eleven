import { randomUUID } from "node:crypto";
import { THREAD_STORE_FILE } from "../paths.ts";
import { debouncedWriter, readJsonFile, writeJsonFile } from "../util.ts";

export interface ThreadEntry {
  id: string;
  /** Durable conversation identity, e.g. "telegram:main:12345" or "dashboard:agent:<uuid>". */
  sessionKey: string;
  workspace: string;
  /** Absolute path of the pi JSONL session file (set after the first turn). */
  sessionFile?: string;
  /** Per-conversation overrides that survive /new. */
  model?: string;
  title?: string;
  createdAt: number;
  lastActivityAt: number;
}

interface StoreShape {
  version: 1;
  threads: Record<string, ThreadEntry>;
  /** sessionKey → id of its current thread. */
  current: Record<string, string>;
}

/**
 * Two-level session identity: a durable sessionKey (where the conversation
 * happens) maps to a rotating thread (one pi session file). `/new` mints a new
 * thread under the same key, preserving per-key preferences.
 */
export class ThreadStore {
  private data: StoreShape;
  private file: string;

  constructor(file = THREAD_STORE_FILE) {
    this.file = file;
    this.data = readJsonFile(this.file, { version: 1, threads: {}, current: {} });
  }

  /** Drop stale threads no conversation points at (gc.ts deletes their files). */
  prune(maxAgeMs: number) {
    const cutoff = Date.now() - maxAgeMs;
    const live = new Set(Object.values(this.data.current));
    let dropped = 0;
    for (const [id, thread] of Object.entries(this.data.threads)) {
      if (!live.has(id) && thread.lastActivityAt < cutoff) {
        delete this.data.threads[id];
        dropped++;
      }
    }
    if (dropped) this.persist();
  }

  /** Current thread for a key, creating one if absent or idle-expired. */
  resolve(sessionKey: string, workspace: string, idleMs: number): ThreadEntry {
    const currentId = this.data.current[sessionKey];
    const current = currentId ? this.data.threads[currentId] : undefined;
    if (current && Date.now() - current.lastActivityAt <= idleMs) return current;
    return this.rotate(sessionKey, workspace, current);
  }

  /** Start a fresh thread for a key (the /new command). */
  rotate(sessionKey: string, workspace: string, previous?: ThreadEntry): ThreadEntry {
    const thread: ThreadEntry = {
      id: randomUUID(),
      sessionKey,
      workspace,
      model: previous?.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.data.threads[thread.id] = thread;
    this.data.current[sessionKey] = thread.id;
    this.persist();
    return thread;
  }

  get(id: string): ThreadEntry | undefined {
    return this.data.threads[id];
  }

  /** Remove a thread from the index; its files on disk are the caller's concern. */
  delete(id: string) {
    const thread = this.data.threads[id];
    if (!thread) return;
    delete this.data.threads[id];
    // Unpin the conversation so its next message rotates a fresh thread.
    if (this.data.current[thread.sessionKey] === id) delete this.data.current[thread.sessionKey];
    this.persist();
  }

  current(sessionKey: string): ThreadEntry | undefined {
    const id = this.data.current[sessionKey];
    return id ? this.data.threads[id] : undefined;
  }

  /** Whether this is the generation currently attached to its conversation. */
  isCurrent(id: string): boolean {
    const thread = this.data.threads[id];
    return !!thread && this.data.current[thread.sessionKey] === id;
  }

  update(id: string, patch: Partial<ThreadEntry>) {
    const thread = this.data.threads[id];
    if (!thread) return;
    Object.assign(thread, patch);
    this.persist();
  }

  list(workspace?: string): ThreadEntry[] {
    return Object.values(this.data.threads)
      .filter((t) => !workspace || t.workspace === workspace)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  // update() runs twice per turn — debounced so a turn costs one write, not two.
  private persist = debouncedWriter(() => writeJsonFile(this.file, this.data));
}

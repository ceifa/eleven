import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { REQUESTS_DIR, THREADS_DIR } from "../paths.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { requestLogFile } from "./request-log.ts";
import type { ThreadStore } from "./store.ts";
import { cleanupClaudeGarbage, cleanupClaudeSessions } from "../agent/claude-code.ts";
import { logger } from "../log.ts";

const log = logger("threads/gc");

/**
 * Delete thread files older than the retention window: prune the index, then
 * remove every session JSONL and request log whose mtime predates the cutoff
 * and that no surviving thread references. The mtime sweep also catches files
 * orphaned before gc existed. Files of live (current) threads are never touched.
 */
export async function collectGarbage(threads: ThreadStore, retentionMs: number): Promise<number> {
  await cleanupClaudeGarbage();
  const pruned = threads.prune(retentionMs);
  await Promise.allSettled(pruned.flatMap((thread) => {
    if (!thread.sessionFile) return [];
    let sessionId: string | undefined;
    try { sessionId = SessionManager.open(thread.sessionFile).getSessionId(); } catch {
      sessionId = thread.sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
    }
    return sessionId ? [cleanupClaudeSessions(sessionId)] : [];
  }));
  const cutoff = Date.now() - retentionMs;
  const keep = new Set<string>();
  for (const thread of threads.list()) {
    if (thread.sessionFile) keep.add(thread.sessionFile);
    keep.add(requestLogFile(thread.id));
  }
  const removed = (await Promise.all([sweep(REQUESTS_DIR, keep, cutoff), sweep(THREADS_DIR, keep, cutoff)])).reduce(
    (total, n) => total + n,
  );
  if (removed) log.info(`removed ${removed} thread file(s) past retention`);
  return removed;
}

async function sweep(root: string, keep: Set<string>, cutoff: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return 0; // directory does not exist yet
  }
  const results = await Promise.allSettled(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => !keep.has(file))
      .map(async (file) => {
        if ((await stat(file)).mtimeMs >= cutoff) return 0;
        await rm(file, { force: true });
        return 1;
      }),
  );
  // deletion is best-effort — rejected entries just don't count
  return results.reduce((removed, r) => removed + (r.status === "fulfilled" ? r.value : 0), 0);
}

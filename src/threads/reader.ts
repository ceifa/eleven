import { stat } from "node:fs/promises";
import { parseSessionEntries, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { contentText, keyedLane, lruTouch, readFileSlice } from "../util.ts";

export interface ThreadMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
  /** Tool calls made by an assistant message, name + one-line summary. */
  toolCalls?: { name: string; summary: string }[];
}

/** A session entry slimmed to its tree link plus the rendered message, if displayable. */
interface Node {
  id: string;
  parentId: string | null;
  message?: ThreadMessage;
}

// Session files are append-only and re-read on every dashboard view — cache the
// parsed nodes and read only the appended tail on growth. LRU-capped so a
// long-lived daemon doesn't accumulate every thread ever opened.
const MAX_CACHED_FILES = 32;
const cache = new Map<string, { size: number; nodes: Node[]; byId: Map<string, Node> }>();
// Two concurrent reads of the same growing file would both append the tail to
// the shared `nodes` array — serialize per file so the cache grows exactly once.
const lanes = new Map<string, Promise<unknown>>();

/**
 * Renders a pi JSONL session file into displayable messages. Files are mostly
 * linear, but model failover rewinds and retries on a new branch — so only the
 * active path (tip of the file back to the root) is rendered, not every entry.
 */
export function readThreadMessages(sessionFile: string): Promise<ThreadMessage[]> {
  return keyedLane(lanes, sessionFile, () => readMessages(sessionFile));
}

async function readMessages(sessionFile: string): Promise<ThreadMessage[]> {
  let size: number;
  try {
    size = (await stat(sessionFile)).size;
  } catch {
    return [];
  }
  let cached = lruTouch(cache, sessionFile);
  if (cached && cached.size > size) cached = undefined; // truncated/replaced — start over

  const nodes = cached?.nodes ?? [];
  const byId = cached?.byId ?? new Map<string, Node>();
  if (!cached || cached.size < size) {
    const from = cached?.size ?? 0;
    const raw = await readFileSlice(sessionFile, from, size - from);
    // The writer may be mid-line at the end — parse only complete lines and
    // resume from there next time.
    const lastNewline = raw.lastIndexOf(0x0a);
    const complete = lastNewline === -1 ? "" : raw.toString("utf8", 0, lastNewline + 1);

    for (const entry of parseSessionEntries(complete)) {
      if (entry.type === "session") continue; // header — not part of the tree
      const node: Node = { id: entry.id, parentId: entry.parentId, message: renderMessage(entry) };
      nodes.push(node);
      byId.set(node.id, node);
    }
    cache.set(sessionFile, { size: from + lastNewline + 1, nodes, byId });
    if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
  }

  // Appending always advances the leaf, so the last entry is the tip of the
  // active branch. The hop cap guards against a malformed parent cycle.
  const messages: ThreadMessage[] = [];
  let hops = nodes.length;
  for (let node = nodes.at(-1); node && hops-- > 0; node = node.parentId ? byId.get(node.parentId) : undefined) {
    if (node.message) messages.push(node.message);
  }
  return messages.reverse();
}

function renderMessage(entry: SessionEntry): ThreadMessage | undefined {
  if (entry.type !== "message") return undefined;
  const { message } = entry as SessionMessageEntry;
  if (message.role === "user") {
    const text = contentText(message.content).trim();
    if (text) return { role: "user", text, timestamp: entry.timestamp };
  } else if (message.role === "assistant") {
    const text = contentText(message.content).trim();
    const toolCalls = message.content
      .filter((c) => c.type === "toolCall")
      .map((c) => ({ name: c.name, summary: summarizeArgs(c.arguments) }));
    if (text || toolCalls.length) {
      return { role: "assistant", text, timestamp: entry.timestamp, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
  }
  return undefined;
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const value = args.path ?? args.file_path ?? args.command ?? args.pattern ?? Object.values(args)[0];
  return typeof value === "string" ? value.slice(0, 120) : "";
}

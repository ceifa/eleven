import { stat } from "node:fs/promises";
import { parseSessionEntries, type CustomEntry, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { contentText, keyedLane, lruTouch, readFileSlice, summarizeToolArgs } from "../util.ts";

/** Custom session entry recording nested-runtime tool calls (Claude Code runs
 *  its own tool loop, so Pi's transcript never sees them as toolCall blocks).
 *  The Runner appends one entry per call, the moment it happens — that's what
 *  makes the record survive a daemon restart mid-turn, exactly like Pi's own
 *  incremental toolCall persistence. Display-only: pi ignores plain custom
 *  entries when it builds LLM context, which is exactly why the agent loop
 *  won't re-execute these. */
export const TOOL_CALLS_ENTRY_TYPE = "eleven:tool-calls";

export interface RecordedToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface ToolCallsEntryData {
  calls: RecordedToolCall[];
}

export interface ThreadMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
  /** Tool calls made by an assistant message: the call id (to fetch its result
   *  lazily), name, a one-line preview, and the full argument object — the
   *  dashboard renders args + result in a JSON viewer on click. */
  toolCalls?: { id: string; name: string; summary: string; args?: Record<string, unknown> }[];
}

/** A tool call's recorded output, fetched on demand (results can be large, so
 *  they're kept out of the thread payload and its turn-done refreshes). */
export interface ToolResult {
  output: string;
  isError: boolean;
}

/** A session entry slimmed to its tree link plus what's displayable: the
 *  rendered message, for toolResult entries the recorded output, or — for
 *  nested-runtime records — the tool calls to fold into their turn's message. */
interface Node {
  id: string;
  parentId: string | null;
  message?: ThreadMessage;
  result?: ToolResult & { toolCallId: string };
  record?: { calls: NonNullable<ThreadMessage["toolCalls"]>; timestamp?: string };
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

/** The recorded output of one tool call, or undefined if the session has none
 *  (e.g. the turn is still running, or the id doesn't match). */
export function readToolResult(sessionFile: string, toolCallId: string): Promise<ToolResult | undefined> {
  return keyedLane(lanes, sessionFile, async () => {
    const parsed = await ensureParsed(sessionFile);
    const node = parsed?.nodes.find((n) => n.result?.toolCallId === toolCallId);
    return node?.result && { output: node.result.output, isError: node.result.isError };
  });
}

// Parses the appended tail into the cached node tree and returns it, or null if
// the file is gone. Callers run inside keyedLane so the cache grows once.
async function ensureParsed(sessionFile: string): Promise<{ nodes: Node[]; byId: Map<string, Node> } | null> {
  let size: number;
  try {
    size = (await stat(sessionFile)).size;
  } catch {
    return null;
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
      const recorded = renderRecordedToolCalls(entry);
      const node: Node = {
        id: entry.id,
        parentId: entry.parentId,
        message: renderMessage(entry),
        result: renderResult(entry),
        ...(recorded ? { record: { calls: recorded, timestamp: entry.timestamp } } : {}),
      };
      nodes.push(node);
      byId.set(node.id, node);
    }
    cache.set(sessionFile, { size: from + lastNewline + 1, nodes, byId });
    if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
  }
  return { nodes, byId };
}

async function readMessages(sessionFile: string): Promise<ThreadMessage[]> {
  const parsed = await ensureParsed(sessionFile);
  if (!parsed) return [];
  const { nodes, byId } = parsed;

  // Appending always advances the leaf, so the last entry is the tip of the
  // active branch. The hop cap guards against a malformed parent cycle.
  const branch: Node[] = [];
  let hops = nodes.length;
  for (let node = nodes.at(-1); node && hops-- > 0; node = node.parentId ? byId.get(node.parentId) : undefined) {
    if (node.message || node.record) branch.push(node);
  }
  branch.reverse();

  // Fold recorded tool calls into their turn's message. Records are written as
  // the calls happen, so they precede their turn's assistant message; older
  // files carry one record right after it (parent = the assistant). Everything
  // is emitted as copies — the cache is shared and reused across reads.
  const messages: ThreadMessage[] = [];
  const emittedAt = new Map<string, number>(); // node id → index in `messages`
  let pending: NonNullable<ThreadMessage["toolCalls"]> = [];
  let pendingTimestamp: string | undefined;
  const flushPending = () => {
    if (!pending.length) return;
    // The turn never produced an assistant message (aborted mid-tool, still
    // running, or the daemon died) — the calls get their own transcript row.
    messages.push({ role: "assistant", text: "", timestamp: pendingTimestamp, toolCalls: pending });
    pending = [];
    pendingTimestamp = undefined;
  };
  for (const node of branch) {
    if (node.record) {
      const parentIndex = node.parentId !== null ? emittedAt.get(node.parentId) : undefined;
      const parent = parentIndex !== undefined ? messages[parentIndex] : undefined;
      if (parent?.role === "assistant") {
        parent.toolCalls = [...node.record.calls, ...(parent.toolCalls ?? [])];
      } else {
        pendingTimestamp ??= node.record.timestamp;
        pending.push(...node.record.calls);
      }
      continue;
    }
    const message = node.message!;
    if (message.role === "assistant") {
      const copy: ThreadMessage = pending.length
        ? { ...message, toolCalls: [...pending, ...(message.toolCalls ?? [])] }
        : { ...message, ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {}) };
      pending = [];
      pendingTimestamp = undefined;
      emittedAt.set(node.id, messages.length);
      messages.push(copy);
    } else {
      flushPending();
      emittedAt.set(node.id, messages.length);
      messages.push(message);
    }
  }
  flushPending();
  return messages;
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
      .map((c) => ({ id: c.id, name: c.name, summary: summarizeToolArgs(c.arguments, 160), args: c.arguments }));
    if (text || toolCalls.length) {
      return { role: "assistant", text, timestamp: entry.timestamp, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
  }
  return undefined;
}

function renderRecordedToolCalls(entry: SessionEntry): NonNullable<ThreadMessage["toolCalls"]> | undefined {
  if (entry.type !== "custom" || entry.customType !== TOOL_CALLS_ENTRY_TYPE) return undefined;
  const calls = ((entry as CustomEntry<ToolCallsEntryData>).data?.calls ?? []).filter((call) => call?.id && call.name);
  if (!calls.length) return undefined;
  return calls.map((call) => ({ id: call.id, name: call.name, summary: summarizeToolArgs(call.args ?? {}, 160), args: call.args }));
}

// toolResult entries aren't shown as their own messages — their output is
// attached to the originating tool call and fetched on demand by call id.
function renderResult(entry: SessionEntry): (ToolResult & { toolCallId: string }) | undefined {
  if (entry.type !== "message") return undefined;
  const { message } = entry as SessionMessageEntry;
  if (message.role !== "toolResult") return undefined;
  return { toolCallId: message.toolCallId, output: contentText(message.content), isError: !!message.isError };
}


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

/** A tool call as the transcript shows it: the call id (to fetch its result
 *  lazily), name, a one-line preview, and the full argument object — the
 *  dashboard renders args + result in a JSON viewer on click. */
export interface ToolCallView {
  id: string;
  name: string;
  summary: string;
  args?: Record<string, unknown>;
}

/**
 * One row of the rendered transcript. Tool calls are their own row rather than
 * a footer on the nearest message: a nested runtime (Claude Code) calls its
 * tools *before* it produces prose, so folding them into the reply printed them
 * under text that came after them. Rows are emitted in file order, which is the
 * order things actually happened.
 */
export type ThreadItem =
  | { kind: "message"; role: "user" | "assistant"; text: string; timestamp?: string }
  | { kind: "tool-calls"; calls: ToolCallView[]; timestamp?: string };

/** A tool call's recorded output, fetched on demand (results can be large, so
 *  they're kept out of the thread payload and its turn-done refreshes). */
export interface ToolResult {
  output: string;
  isError: boolean;
}

/** A session entry slimmed to its tree link plus what's displayable: the
 *  rendered message, the tool calls it made (pi's own toolCall blocks, or a
 *  nested runtime's recorded ones), and for toolResult entries the output. */
interface Node {
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: { role: "user" | "assistant"; text: string };
  calls?: ToolCallView[];
  result?: ToolResult & { toolCallId: string };
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
export function readThreadTimeline(sessionFile: string): Promise<ThreadItem[]> {
  return keyedLane(lanes, sessionFile, () => buildTimeline(sessionFile));
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
  } catch (error: unknown) {
    // A deleted session legitimately renders as an empty thread. An unreadable
    // one must not: answering "no history" to a permission or I/O failure hides
    // the fault, and reads as a transcript that failed to record.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read session ${sessionFile}: ${error}`);
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
      const node: Node = {
        id: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        ...renderMessage(entry),
        ...(renderRecordedToolCalls(entry) ?? {}),
        result: renderResult(entry),
      };
      nodes.push(node);
      byId.set(node.id, node);
    }
    cache.set(sessionFile, { size: from + lastNewline + 1, nodes, byId });
    if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
  }
  return { nodes, byId };
}

async function buildTimeline(sessionFile: string): Promise<ThreadItem[]> {
  const parsed = await ensureParsed(sessionFile);
  if (!parsed) return [];
  const { nodes, byId } = parsed;

  // Appending always advances the leaf, so the last entry is the tip of the
  // active branch. The hop cap guards against a malformed parent cycle.
  const branch: Node[] = [];
  let hops = nodes.length;
  for (let node = nodes.at(-1); node && hops-- > 0; node = node.parentId ? byId.get(node.parentId) : undefined) {
    if (node.message || node.calls) branch.push(node);
  }
  branch.reverse();

  // File order is chronological order, so the rows come out in it: text where
  // the model wrote text, tool calls where it called tools. Consecutive tool
  // entries (a nested runtime writes one per call) merge into a single block so
  // the transcript reads as one list, not one row per record. Rows own fresh
  // arrays — the parsed nodes are cached and reused across reads.
  const items: ThreadItem[] = [];
  const pushCalls = (calls: ToolCallView[], timestamp?: string) => {
    const last = items.at(-1);
    if (last?.kind === "tool-calls") last.calls.push(...calls);
    else items.push({ kind: "tool-calls", calls: [...calls], timestamp });
  };
  for (const node of branch) {
    if (node.message?.text) items.push({ kind: "message", ...node.message, timestamp: node.timestamp });
    if (node.calls?.length) pushCalls(node.calls, node.timestamp);
  }
  return items;
}

/** The displayable halves of a message entry: its prose and its tool calls. */
function renderMessage(entry: SessionEntry): Pick<Node, "message" | "calls"> {
  if (entry.type !== "message") return {};
  const { message } = entry as SessionMessageEntry;
  if (message.role === "user") {
    return { message: { role: "user", text: contentText(message.content).trim() } };
  }
  if (message.role === "assistant") {
    const calls = message.content
      .filter((c) => c.type === "toolCall")
      .map((c) => ({ id: c.id, name: c.name, summary: summarizeToolArgs(c.arguments, 160), args: c.arguments }));
    return { message: { role: "assistant", text: contentText(message.content).trim() }, ...(calls.length ? { calls } : {}) };
  }
  return {};
}

function renderRecordedToolCalls(entry: SessionEntry): Pick<Node, "calls"> | undefined {
  if (entry.type !== "custom" || entry.customType !== TOOL_CALLS_ENTRY_TYPE) return undefined;
  const calls = ((entry as CustomEntry<ToolCallsEntryData>).data?.calls ?? []).filter((call) => call?.id && call.name);
  if (!calls.length) return undefined;
  return { calls: calls.map((call) => ({ id: call.id, name: call.name, summary: summarizeToolArgs(call.args ?? {}, 160), args: call.args })) };
}

// toolResult entries aren't shown as their own messages — their output is
// attached to the originating tool call and fetched on demand by call id.
function renderResult(entry: SessionEntry): (ToolResult & { toolCallId: string }) | undefined {
  if (entry.type !== "message") return undefined;
  const { message } = entry as SessionMessageEntry;
  if (message.role !== "toolResult") return undefined;
  return { toolCallId: message.toolCallId, output: contentText(message.content), isError: !!message.isError };
}


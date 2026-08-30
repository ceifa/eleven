/* The shape of a running turn, kept out of the SPA so it can be reasoned about
   — and tested — without a DOM. A "live turn" is the ordered record of what the
   turn has produced so far: prose, tool calls, provider requests, and the
   messages that arrived while it was running. */

import { sameMessage } from "./message-display.js";

/** How much of a message is compared when deciding two are the same one. The
 *  activity broadcast clips long messages, so identity is a prefix. */
export const MATCH_CHARS = 200;

/** How long after its last delta a turn still reads as "writing" rather than
 *  as having gone quiet again. */
const WRITING_WINDOW_MS = 1500;

/**
 * What the running turn is doing right now, in one short line. Everything here
 * is read off what the turn actually produced — the label never claims more
 * than the events say, because "Thinking…" over a turn that is really stuck is
 * exactly the lie this line exists to stop telling.
 */
export function liveStatus(live, { now = Date.now(), lastDeltaAt = 0 } = {}) {
  const last = live.at(-1);
  if (last?.kind === "text" && now - lastDeltaAt < WRITING_WINDOW_MS) return "Writing…";
  if (last?.kind === "tool") return `Using ${last.name}…`;
  return "Thinking…";
}

/** m:ss since the turn began — the one number that tells a silent turn from a
 *  hung one. */
export function elapsed(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Is this durable transcript row already on screen as part of the running turn?
 *
 * A message that arrives mid-turn is steered into it and persisted the moment
 * it lands, so it exists in both records at once: the transcript (which knows
 * nothing about where the turn's streamed prose goes) and the live turn (which
 * knows exactly where it landed). The live one wins — that's what puts the
 * message where it was sent instead of above everything the turn has said —
 * and this is what keeps the transcript from drawing it a second time.
 *
 * Only rows from this turn are eligible: an older message that happens to
 * repeat the same text is a different message, and must still render.
 */
export function shownLive(live, item, at, startedAt) {
  if (item.kind !== "message" || !startedAt || !(at >= startedAt)) return false;
  return live.some((entry) => entry.kind === "message" && sameMessage(entry, item, MATCH_CHARS));
}

/* ---------- the turn's plan and subagents ---------- */

/** State reads at a glance or it doesn't read at all: the icon is the status. */
export function taskIcon(task) {
  if (task.status === "completed") return "✓";
  if (task.status === "failed") return "✕";
  if (task.status === "stopped") return "◼";
  if (task.status === "running") return "◐";
  return task.blockedBy?.length ? "⏸" : "○";
}

export const fmtTokens = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tok` : `${n} tok`;

export const fmtDuration = (ms) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** The one line of context an agent row carries next to its title. Live rows
 *  say what the agent is doing; finished ones say what it cost. */
export function agentMeta(task) {
  const parts = [];
  if (task.status === "running" && task.lastToolName) parts.push(task.lastToolName);
  if (task.usage?.totalTokens !== undefined) parts.push(fmtTokens(task.usage.totalTokens));
  if (task.usage?.durationMs !== undefined) parts.push(fmtDuration(task.usage.durationMs));
  if (task.status !== "running" && task.summary && task.summary.trim().toLowerCase() !== task.title.trim().toLowerCase()) {
    parts.push(task.summary);
  }
  return parts;
}

/**
 * Everything known about one subagent, as label/value pairs for the detail
 * panel. Deliberately only what the runtime actually reported: eleven does not
 * see a subagent's provider requests — a nested runtime drives its own tool
 * loop — so this never invents a per-agent request it cannot show.
 */
export function agentDetail(task) {
  const rows = [["status", task.status]];
  if (task.subagentType) rows.push(["type", task.subagentType]);
  if (task.taskType) rows.push(["runs as", task.taskType]);
  if (task.lastToolName) rows.push(["last tool", task.lastToolName]);
  if (task.usage?.totalTokens !== undefined) rows.push(["tokens", fmtTokens(task.usage.totalTokens)]);
  if (task.usage?.toolUses !== undefined) rows.push(["tool calls", String(task.usage.toolUses)]);
  if (task.usage?.durationMs !== undefined) rows.push(["duration", fmtDuration(task.usage.durationMs)]);
  if (task.blockedBy?.length) rows.push(["blocked by", task.blockedBy.map((id) => `#${id}`).join(", ")]);
  return rows;
}

/** Does the board have anything worth a region on screen? */
export const hasTasks = (tasks) => !!(tasks?.plan?.length || tasks?.agents?.length);

export const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);

/** Messages closer together than this, from the same speaker, read as one block. */
const GROUP_WINDOW_MS = 4 * 60_000;

/**
 * The durable transcript as an ordered list of rows to draw — no DOM, so the
 * question "what goes where" has one answer that can be looked at.
 *
 * Everything is placed by its own timestamp. That is the point: a run of tool
 * calls is only merged into one block *after* the sort, when nothing sorted
 * between them. Merging earlier (the reader used to) put a whole turn's calls
 * on the first call's clock, and then every provider-request chip in that turn
 * had no choice but to pile up after the block instead of sitting between the
 * calls it explains.
 */
export function transcriptRows({ timeline, requests = [], live = [], liveStartedAt = 0, showRequests = false }) {
  // Tool calls and requests the live region is already drawing: they belong to
  // the running turn, which knows how they interleave with prose the transcript
  // cannot see.
  const liveIds = new Set(live.filter((item) => item.id !== undefined).map((item) => item.id));
  const rows = [];
  let at = 0;
  for (const item of timeline) {
    // Undated rows (older sessions) inherit the last known time so they can't
    // sort to the top of the transcript.
    at = Date.parse(item.timestamp) || at;
    if (item.kind === "message") {
      if (shownLive(live, item, at, liveStartedAt)) continue;
      rows.push({ kind: "message", at, tie: 0, message: item });
    } else if (item.kind === "error") {
      rows.push({ kind: "error", at, tie: 0, text: item.text });
    } else {
      const calls = item.calls.filter((call) => !liveIds.has(call.id));
      if (calls.length) rows.push({ kind: "tool-calls", at, tie: 0, calls });
    }
  }
  // The exact moments eleven called an AI provider, interleaved by time — a
  // request precedes the message it produced, hence the tiebreak.
  if (showRequests) {
    for (const request of requests) {
      if (!liveIds.has(request.id)) rows.push({ kind: "request", at: request.at, tie: 1, request });
    }
  }
  rows.sort((a, b) => a.at - b.at || a.tie - b.tie);

  const out = [];
  let day;
  let lastRole;
  let lastAt = 0;
  for (const row of rows) {
    // A transcript spanning days reads as one endless column without these —
    // and "when did I ask that?" is the question a reader scrolls back with.
    const rowDay = row.at ? startOfDay(row.at) : undefined;
    if (rowDay !== undefined && rowDay !== day) {
      day = rowDay;
      lastRole = undefined;
      out.push({ kind: "day", at: row.at });
    }
    const previous = out.at(-1);
    if (row.kind === "tool-calls" && previous?.kind === "tool-calls") {
      previous.calls = [...previous.calls, ...row.calls];
      continue;
    }
    if (row.kind !== "message") {
      lastRole = undefined; // anything between two messages breaks the run
      out.push({ ...row });
      continue;
    }
    out.push({ ...row, grouped: row.message.role === lastRole && row.at - lastAt < GROUP_WINDOW_MS });
    lastRole = row.message.role;
    lastAt = row.at;
  }
  return out;
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildUsageReport,
  cacheWasteOf,
  cacheHitRate,
  localDay,
  readSessionUsage,
  startOfLocalDay,
  type UsageSample,
} from "../src/threads/usage.ts";

const dir = mkdtempSync(join(tmpdir(), "eleven-usage-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

let files = 0;
/** A session file of its own per test — the reader memoizes by path and size. */
function sessionFile(...lines: unknown[]): string {
  const file = join(dir, `session-${++files}.jsonl`);
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

const usage = (over: Partial<Record<"input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "cost", number>> = {}) => ({
  input: over.input ?? 0,
  output: over.output ?? 0,
  reasoning: over.reasoning ?? 0,
  cacheRead: over.cacheRead ?? 0,
  cacheWrite: over.cacheWrite ?? 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: over.cost ?? 0 },
});

const response = (at: string, provider: string, model: string, over?: Parameters<typeof usage>[0]) => ({
  type: "message",
  timestamp: at,
  message: { role: "assistant", provider, model, timestamp: Date.parse(at), usage: usage(over) },
});

/** A sample as the aggregators want it, without going through a file. */
const sample = (over: Partial<UsageSample>): UsageSample => ({
  at: 0, model: "openai-codex/gpt-5", compaction: false, nested: false,
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  ...over,
});

test("only what a provider was actually paid for becomes a sample", async () => {
  const file = sessionFile(
    { type: "message", timestamp: "2026-08-01T10:00:00.000Z", message: { role: "user", content: "how much usage did we have?" } },
    response("2026-08-01T10:00:01.000Z", "openai-codex", "gpt-5", { input: 500, output: 40, reasoning: 12, cacheRead: 9_000, cost: 0.25 }),
    // A tool result quoting the marker: it is not a message, and it is not paid work.
    { type: "message", timestamp: "2026-08-01T10:00:02.000Z", message: { role: "toolResult", content: '{"usage":{"input":999999}}' } },
    // Prose an operator delivered without a model — eleven writes a zeroed
    // usage block for it, and counting it would dilute every average.
    response("2026-08-01T10:00:03.000Z", "eleven", "gpt-5"),
    { type: "compaction", timestamp: "2026-08-01T10:00:04.000Z", summary: "…", usage: usage({ input: 120_000, output: 6_000, cost: 0.79 }) },
  );

  const samples = await readSessionUsage(file);
  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((s) => ({ model: s.model, compaction: s.compaction, input: s.input, cacheRead: s.cacheRead, cost: s.cost })),
    [
      { model: "openai-codex/gpt-5", compaction: false, input: 500, cacheRead: 9_000, cost: 0.25 },
      { model: "", compaction: true, input: 120_000, cacheRead: 0, cost: 0.79 },
    ],
  );
  assert.equal(samples[0].reasoning, 12);
});

test("a runtime that runs its own tool loop is flagged, because its row is a sum of requests", async () => {
  const file = sessionFile(
    response("2026-08-01T10:00:00.000Z", "claude-code", "opus", { cacheRead: 4_000_000, cacheWrite: 90_000 }),
    response("2026-08-01T10:01:00.000Z", "openai-codex", "gpt-5", { input: 200, cacheRead: 40_000 }),
  );
  const samples = await readSessionUsage(file);
  assert.deepEqual(samples.map((s) => s.nested), [true, false]);
});

test("a tool result too large to hold doesn't hide the responses around it", async () => {
  // One line past the reader's cap, one line past a single read — a sample must
  // survive both a dropped monster and a straddled chunk boundary.
  const monster = JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(5 << 20) } });
  const straddler = JSON.stringify({ type: "message", message: { role: "toolResult", content: "y".repeat(300 * 1024) } });
  const file = sessionFile(
    response("2026-08-01T10:00:00.000Z", "openai-codex", "gpt-5", { input: 10, output: 1 }),
    monster,
    straddler,
    response("2026-08-01T10:05:00.000Z", "openai-codex", "gpt-5", { input: 20, output: 2 }),
  );
  const samples = await readSessionUsage(file);
  assert.deepEqual(samples.map((s) => s.input), [10, 20]);
});

test("a session with no file at all reports nothing rather than throwing", async () => {
  assert.deepEqual(await readSessionUsage(join(dir, "does-not-exist.jsonl")), []);
});

test("a response is cold only when a warm cache was there to lose", () => {
  const minute = 60_000;
  const waste = cacheWasteOf([
    // The first response of a session had no cache to keep warm.
    sample({ at: 0, input: 50_000 }),
    // Warm: the new user message is fresh input, but under the noise floor.
    sample({ at: minute, input: 900, cacheRead: 50_000 }),
    // Idle past the five-minute TTL, and it shows: the prompt was re-billed.
    sample({ at: 40 * minute, input: 60_000 }),
    // A fallback down the sequence — a different model is always a cold cache.
    sample({ at: 41 * minute, model: "claude-code/opus", cacheWrite: 61_000, cacheRead: 1_000 }),
    // Cold for some other reason (a fork, a system-prompt edit): not blamed on
    // anything, so not counted. This is a floor, not a ceiling.
    sample({ at: 42 * minute, model: "claude-code/opus", input: 70_000 }),
  ]);
  assert.deepEqual(waste, { coldTokens: 121_000, coldResponses: 2, idleResponses: 1, modelSwitchResponses: 1 });
});

test("cache hit rate is a share of the prompt, and undefined when there was no prompt", () => {
  assert.equal(cacheHitRate({ responses: 1, input: 1_000, output: 500, reasoning: 0, cacheRead: 9_000, cacheWrite: 0, cost: 0 }), 0.9);
  assert.equal(cacheHitRate({ responses: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), undefined);
});

test("the window filters samples, not files — and days are the reader's, not UTC's", async () => {
  const old = "2026-07-01T12:00:00.000Z";
  const recent = "2026-08-20T12:00:00.000Z";
  const newer = "2026-08-21T12:00:00.000Z";
  const busy = sessionFile(
    response(old, "openai-codex", "gpt-5", { input: 1_000, cost: 1 }),
    response(recent, "openai-codex", "gpt-5", { input: 100, cacheRead: 5_000, output: 50, cost: 2 }),
    response(newer, "claude-code", "opus", { cacheRead: 8_000, cacheWrite: 400, output: 60, cost: 4 }),
  );
  const quiet = sessionFile(response(recent, "openai-codex", "gpt-5", { input: 30, output: 5, cost: 0.5 }));
  const sources = [
    { id: "busy", sessionFile: busy, title: "the busy one", workspace: "agent" },
    { id: "quiet", sessionFile: quiet, title: "the quiet one", workspace: "work" },
    { id: "fileless", workspace: "agent" },
  ];

  const report = await buildUsageReport(sources, Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(report.threads, 2);
  assert.equal(report.total.responses, 3, "the July response is outside the window");
  assert.equal(report.total.cost, 6.5);
  assert.equal(report.oldestAt, Date.parse(old), "coverage reports what is on disk, not what the window asked for");

  assert.deepEqual(report.byModel.map((entry) => entry.model), ["claude-code/opus", "openai-codex/gpt-5"], "sorted by spend");
  assert.equal(report.byModel[1].bucket.responses, 2);

  assert.deepEqual(report.byDay.map((day) => day.day), [localDay(Date.parse(recent)), localDay(Date.parse(newer))]);
  assert.deepEqual(Object.keys(report.byDay[1].byModel), ["claude-code/opus"]);

  assert.deepEqual(report.byThread.map((thread) => thread.id), ["busy", "quiet"], "sorted by tokens; the fileless thread is absent");
  assert.equal(report.byThread[0].lastModel, "claude-code/opus");
  assert.equal(report.byThread[0].workspace, "agent");
});

test("an empty window answers with zeroes instead of nothing", async () => {
  const file = sessionFile(response("2026-07-01T12:00:00.000Z", "openai-codex", "gpt-5", { input: 10 }));
  const report = await buildUsageReport([{ id: "t", sessionFile: file, workspace: "agent" }], Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(report.total.responses, 0);
  assert.equal(report.threads, 0);
  assert.deepEqual(report.byDay, []);
  assert.equal(report.oldestAt, Date.parse("2026-07-01T12:00:00.000Z"), "the files were still read, so coverage is still known");
});

test("a window starts at a day boundary, so its first bar is a whole day", () => {
  const noon = new Date(2026, 7, 30, 12, 34, 56).getTime();
  assert.equal(localDay(startOfLocalDay(noon)), "2026-08-30");
  assert.equal(localDay(startOfLocalDay(noon, 6)), "2026-08-24");
  assert.equal(new Date(startOfLocalDay(noon)).getHours(), 0);
  // Across a month edge, and across whatever DST does to the length of a day.
  assert.equal(localDay(startOfLocalDay(new Date(2026, 2, 2, 3).getTime(), 5)), "2026-02-25");
});

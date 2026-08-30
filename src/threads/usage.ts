import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { lruTouch } from "../util.ts";

/**
 * Token accounting, read straight off pi's session transcripts.
 *
 * Every assistant response pi persists carries a `usage` block — prompt tokens
 * split into fresh input, cache reads and cache writes, output tokens (with the
 * reasoning share inside them), and the list price of all of it. Compaction
 * entries carry one too, for the summarization call itself. So nothing here
 * needs to be recorded at turn time: the numbers are already on disk, and the
 * job of this file is to walk them cheaply.
 *
 * Cheaply matters, because a session file can be tens of megabytes of tool
 * results. Like search.ts, this reads a block at a time and only parses a line
 * that has the substring worth parsing for — a whole history scans in about a
 * second. Results are memoized per file *and size*, so an appended session
 * simply misses and gets rescanned.
 */

/** Read size — the same tradeoff search.ts makes: a few syscalls per file. */
const CHUNK = 256 * 1024;
/** Assistant messages get long, but not this long: past here it is a tool
 *  result, and holding it whole would cost more than the sample is worth. */
const MAX_LINE = 4 << 20;
/** Only a line carrying this is worth JSON.parse. */
const USAGE_MARK = '"usage"';
const MAX_CACHED_FILES = 512;

/**
 * Anthropic's prompt cache expires five minutes after the last write, and
 * OpenAI's implicit cache is in the same neighbourhood. A gap wider than this
 * between two requests is the likeliest explanation for a prompt that had to be
 * paid for in full — and for a chat agent, whose turns are minutes or hours
 * apart, it is the normal case rather than a bug.
 */
export const CACHE_TTL_MS = 5 * 60_000;
/**
 * Below this, prompt tokens billed outside the cache are noise rather than a
 * cold start: the new user message, a tool result, a system-prompt edit that
 * shifted the cache breakpoint by a few hundred tokens.
 */
export const COLD_PROMPT_FLOOR = 4_096;

/**
 * Providers whose runtime runs its own tool loop, so one persisted message is
 * the sum of every request that loop made — not one request. Their token totals
 * are exact; their *per-response* prompt size is not a context-window reading,
 * and nothing here may present it as one.
 */
const NESTED_PROVIDERS = new Set(["claude-code"]);

/** What one provider response reported. */
export interface UsageSample {
  /** When the response landed (epoch ms). */
  at: number;
  /** "provider/id" — empty for a compaction, which pi records without one. */
  model: string;
  /** A compaction call rather than a turn: cost the conversation paid to keep
   *  talking, which belongs in the total but not in any model's turn count. */
  compaction: boolean;
  /** This row sums a nested runtime's whole tool loop (see NESTED_PROVIDERS),
   *  so its prompt size is a total, not the size of one request. */
  nested: boolean;
  /** Prompt tokens billed fresh (no cache hit). */
  input: number;
  output: number;
  /** The reasoning share of `output` — a subset, not an addition. */
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** List price in USD, as the provider or pi's price table computed it. */
  cost: number;
}

/** Summed usage over any set of samples. */
export interface UsageBucket {
  responses: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * Prompt tokens paid for outside the cache on a response that had a warm cache
 * available to it — and lost it. Counted per session, because the cache is
 * per-session: coldness is only ever measurable against the response before it.
 */
export interface CacheWaste {
  /** Prompt tokens billed fresh or re-written across all cold responses. */
  coldTokens: number;
  /** Responses that came in cold above the noise floor. */
  coldResponses: number;
  /** Of those, the ones whose previous response predates the cache TTL — for a
   *  chat agent, whose turns are minutes or hours apart, the normal case. */
  idleResponses: number;
  /** Of those, the ones where the model changed: a fallback down the sequence,
   *  or an edit to it. A different model is always a cold cache. */
  modelSwitchResponses: number;
}

export function emptyBucket(): UsageBucket {
  return { responses: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addSample(bucket: UsageBucket, sample: UsageSample): UsageBucket {
  bucket.responses += 1;
  bucket.input += sample.input;
  bucket.output += sample.output;
  bucket.reasoning += sample.reasoning;
  bucket.cacheRead += sample.cacheRead;
  bucket.cacheWrite += sample.cacheWrite;
  bucket.cost += sample.cost;
  return bucket;
}

/** Everything that went into the model's context window on one request. */
export const promptTokens = (sample: UsageSample): number => sample.input + sample.cacheRead + sample.cacheWrite;

/** Share of prompt tokens served from cache, 0..1 — undefined when nothing was
 *  sent at all, which is not the same fact as a 0% hit rate. */
export function cacheHitRate(bucket: UsageBucket): number | undefined {
  const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite;
  return prompt ? bucket.cacheRead / prompt : undefined;
}

/**
 * Cold-cache accounting across one session's samples, which must be in file
 * order.
 *
 * What is measured per response is `input + cacheWrite`: every prompt token the
 * cache did *not* serve. That is exact, and — unlike comparing this prompt
 * against the previous one — it survives a nested runtime whose single row sums
 * a whole tool loop. What is estimated is only the *blame*: a response counts as
 * cold when the one before it is older than the cache TTL, or ran on a different
 * model. Anything cold for another reason (a fork, a system-prompt edit) is left
 * out rather than guessed at, so this number is a floor, not a ceiling.
 *
 * The first response of a session is never counted: there was no warm cache to
 * lose. Neither is anything under the noise floor, which is where an ordinary
 * warm turn's new user message lives.
 */
export function cacheWasteOf(samples: UsageSample[]): CacheWaste {
  const waste: CacheWaste = { coldTokens: 0, coldResponses: 0, idleResponses: 0, modelSwitchResponses: 0 };
  let previous: UsageSample | undefined;
  for (const sample of samples) {
    const cold = sample.input + sample.cacheWrite;
    if (previous && cold >= COLD_PROMPT_FLOOR) {
      const idle = sample.at - previous.at > CACHE_TTL_MS;
      const switched = sample.model !== previous.model;
      if (idle || switched) {
        waste.coldTokens += cold;
        waste.coldResponses += 1;
        if (idle) waste.idleResponses += 1;
        if (switched) waste.modelSwitchResponses += 1;
      }
    }
    // A compaction is a paid call like any other, and the turn after it is
    // measured against it — which is right: the compaction is what last
    // refreshed the cache.
    previous = sample;
  }
  return waste;
}

export function mergeWaste(into: CacheWaste, from: CacheWaste): CacheWaste {
  into.coldTokens += from.coldTokens;
  into.coldResponses += from.coldResponses;
  into.idleResponses += from.idleResponses;
  into.modelSwitchResponses += from.modelSwitchResponses;
  return into;
}

const cache = new Map<string, UsageSample[]>();

/**
 * Every usage-bearing entry in a session file, oldest first. A missing or
 * unreadable file yields nothing: a thread whose transcript has been collected
 * still exists, it just has no numbers left to report.
 */
export async function readSessionUsage(sessionFile: string): Promise<UsageSample[]> {
  let size: number;
  try {
    size = (await stat(sessionFile)).size;
  } catch {
    return [];
  }
  const key = `${sessionFile}\0${size}`;
  const cached = lruTouch(cache, key);
  if (cached) return cached;

  const samples = await scan(sessionFile);
  cache.set(key, samples);
  if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
  return samples;
}

async function scan(sessionFile: string): Promise<UsageSample[]> {
  const samples: UsageSample[] = [];
  let handle;
  try {
    handle = await open(sessionFile, "r");
  } catch {
    return samples;
  }
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK);
      if (!bytesRead) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      const cut = text.lastIndexOf("\n");
      if (cut === -1) {
        carry += text;
        // A line no message would ever be. Stop accumulating it and let the
        // next newline resynchronize; its tail parses as nothing.
        if (carry.length > MAX_LINE) carry = "";
        continue;
      }
      const block = carry + text.slice(0, cut);
      carry = text.slice(cut + 1);
      // One substring pass over the whole block: splitting it into lines only
      // happens where a sample could actually be.
      if (block.includes(USAGE_MARK)) {
        for (const line of block.split("\n")) collect(line, samples);
      }
    }
    if (carry) collect(carry, samples);
  } finally {
    await handle.close();
  }
  return samples;
}

function collect(line: string, samples: UsageSample[]): void {
  if (!line.includes(USAGE_MARK)) return;
  const sample = sampleOf(line);
  if (sample) samples.push(sample);
}

interface RawUsage {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | unknown;
}

interface RawEntry {
  type?: unknown;
  timestamp?: unknown;
  usage?: RawUsage;
  message?: { role?: unknown; provider?: unknown; model?: unknown; timestamp?: unknown; usage?: RawUsage };
}

function sampleOf(line: string): UsageSample | undefined {
  let entry: RawEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined; // a half-written tail line — the next read will have it whole
  }
  const compaction = entry.type === "compaction";
  const message = entry.message;
  // Assistant responses and compactions are the only entries a provider was
  // paid for; a user message quoting the word "usage" is not one.
  if (!compaction && (entry.type !== "message" || message?.role !== "assistant")) return undefined;
  const usage = compaction ? entry.usage : message?.usage;
  if (!usage || typeof usage.input !== "number") return undefined;
  const at = number(message?.timestamp) ?? Date.parse(String(entry.timestamp ?? ""));
  if (!Number.isFinite(at)) return undefined;
  const provider = typeof message?.provider === "string" ? message.provider : "";
  const id = typeof message?.model === "string" ? message.model : "";
  const cost = usage.cost;
  const sample: UsageSample = {
    at,
    model: compaction || !id ? "" : provider ? `${provider}/${id}` : id,
    compaction,
    nested: NESTED_PROVIDERS.has(provider),
    input: usage.input,
    output: number(usage.output) ?? 0,
    reasoning: number(usage.reasoning) ?? 0,
    cacheRead: number(usage.cacheRead) ?? 0,
    cacheWrite: number(usage.cacheWrite) ?? 0,
    cost: (cost && typeof cost === "object" ? number((cost as { total?: unknown }).total) : number(cost)) ?? 0,
  };
  // Eleven writes a zeroed usage block for prose an operator delivered without
  // a model — a real message in the transcript, but nothing a provider was paid
  // for. Counting it would dilute every average on the page.
  return sample.input || sample.output || sample.cacheRead || sample.cacheWrite ? sample : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* ---------- cross-thread aggregation ---------- */

/** What the report needs to know about a thread to attribute its tokens. */
export interface UsageSource {
  id: string;
  sessionFile?: string;
  title?: string;
  workspace: string;
  conversation?: string;
}

export interface ThreadUsage extends UsageBucket {
  id: string;
  title?: string;
  workspace: string;
  conversation?: string;
  /** The model that answered last — which sequence step the thread ended on. */
  lastModel: string;
  lastAt: number;
}

export interface DayUsage {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  total: UsageBucket;
  /** Per model, plus "" for compactions. */
  byModel: Record<string, UsageBucket>;
}

export interface UsageReport {
  /** Start of the window (epoch ms). */
  since: number;
  total: UsageBucket;
  compaction: UsageBucket;
  waste: CacheWaste;
  byDay: DayUsage[];
  byModel: { model: string; bucket: UsageBucket }[];
  byThread: ThreadUsage[];
  /** Oldest response still on disk, whatever the window asked for — the honest
   *  edge of the data, since gc deletes session files on a retention timer. */
  oldestAt?: number;
  /** Threads that carried usage, and how many of them the window covers. */
  threads: number;
}

/** How many session files are read at once. Each is a handful of syscalls, and
 *  a personal gateway has hundreds of threads, not thousands. */
const SCAN_BATCH = 8;

/**
 * Usage across every thread, in one pass over what is on disk.
 *
 * The window filters samples, not files: cache waste is measured against the
 * request before it, which may be older than the window, so a session is always
 * walked whole and its samples are attributed afterwards.
 */
export async function buildUsageReport(sources: UsageSource[], since: number): Promise<UsageReport> {
  const withFiles = sources.filter((source): source is UsageSource & { sessionFile: string } => Boolean(source.sessionFile));
  const report: UsageReport = {
    since,
    total: emptyBucket(),
    compaction: emptyBucket(),
    waste: { coldTokens: 0, coldResponses: 0, idleResponses: 0, modelSwitchResponses: 0 },
    byDay: [],
    byModel: [],
    byThread: [],
    threads: 0,
  };
  const days = new Map<string, DayUsage>();
  const models = new Map<string, UsageBucket>();

  for (let i = 0; i < withFiles.length; i += SCAN_BATCH) {
    const batch = withFiles.slice(i, i + SCAN_BATCH);
    const scanned = await Promise.all(batch.map(async (source) => ({ source, samples: await readSessionUsage(source.sessionFile) })));
    for (const { source, samples } of scanned) {
      if (!samples.length) continue;
      const oldest = samples[0].at;
      if (report.oldestAt === undefined || oldest < report.oldestAt) report.oldestAt = oldest;
      const inWindow = samples.filter((sample) => sample.at >= since);
      if (!inWindow.length) continue;
      report.threads += 1;
      mergeWaste(report.waste, cacheWasteOf(inWindow));
      const thread: ThreadUsage = {
        ...emptyBucket(),
        id: source.id,
        title: source.title,
        workspace: source.workspace,
        conversation: source.conversation,
        lastModel: inWindow[inWindow.length - 1].model,
        lastAt: inWindow[inWindow.length - 1].at,
      };
      for (const sample of inWindow) {
        addSample(report.total, sample);
        addSample(thread, sample);
        if (sample.compaction) addSample(report.compaction, sample);
        addSample(models.get(sample.model) ?? setAndGet(models, sample.model, emptyBucket()), sample);
        const key = localDay(sample.at);
        const day = days.get(key) ?? setAndGet(days, key, { day: key, total: emptyBucket(), byModel: {} });
        addSample(day.total, sample);
        addSample(day.byModel[sample.model] ??= emptyBucket(), sample);
      }
      report.byThread.push(thread);
    }
  }

  report.byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  report.byModel = [...models.entries()]
    .map(([model, bucket]) => ({ model, bucket }))
    .sort((a, b) => b.bucket.cost - a.bucket.cost || tokensOf(b.bucket) - tokensOf(a.bucket));
  report.byThread.sort((a, b) => tokensOf(b) - tokensOf(a));
  return report;
}

const tokensOf = (bucket: UsageBucket) => bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;

function setAndGet<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  return value;
}

/** The calendar day a timestamp falls on *where the daemon runs* — days are
 *  read by a person in their own timezone, not in UTC. */
export function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Midnight, `daysBack` calendar days before the day `at` falls on. A window
 * that starts at a day boundary rather than at "now minus N×24h" is what keeps
 * the first bar of a chart from being a stub of a day nobody asked about — and
 * going through the Date constructor is what keeps it correct across a DST
 * change, where a day is not 24 hours long.
 */
export function startOfLocalDay(at: number, daysBack = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

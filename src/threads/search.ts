import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { contentText, lruTouch } from "../util.ts";

/**
 * Full-text search over pi session transcripts.
 *
 * The point of this file is what it refuses to do. Sessions are append-only
 * JSONL on disk, and a single line can be a whole tool result — a file dump, a
 * command's output, megabytes of it. So nothing here builds an index or holds a
 * transcript in memory: a file is walked a block at a time and each block is
 * tested *whole*, with one native regex pass and no allocation. Only a block
 * that actually contains the query is split into lines, and only a line that
 * contains it is parsed as JSON. What travels back to the browser is a handful
 * of clipped snippets, never a transcript.
 */

/** Read size. Big enough that a session file is a handful of syscalls, small
 *  enough that concurrent searches stay in a few megabytes. */
const CHUNK = 256 * 1024;
/** A line longer than this is a tool result, not a message — and matches only
 *  ever come from messages. Testing it would mean holding it in memory whole. */
const MAX_LINE = 1 << 20;
/** How much of the surrounding text a snippet carries on each side. */
const SNIPPET_RADIUS = 90;
/** Repeat searches are the norm — a re-render, a filter toggle, a message
 *  arriving while a query is active. Results are memoized per file *and size*,
 *  so an appended session simply misses and gets rescanned. */
const MAX_CACHED_SEARCHES = 2048;

export interface TranscriptMatch {
  role: "user" | "assistant";
  timestamp?: string;
  /** The matching text, clipped around the hit. */
  snippet: string;
}

/** Letters that should match their accented forms, so "condominio" finds
 *  "condomínio" — without normalizing the haystack, which would mean allocating
 *  a transformed copy of every byte scanned. */
const ACCENTS: Record<string, string> = {
  a: "aàáâãäå",
  c: "cç",
  e: "eèéêë",
  i: "iìíîï",
  n: "nñ",
  o: "oòóôõö",
  u: "uùúûü",
  y: "yýÿ",
};
const DIACRITICS = /\p{Diacritic}/gu;

/**
 * The query as one case- and accent-insensitive regex.
 *
 * This is the whole performance story: matching becomes a single native scan
 * over whatever string it's handed, instead of lowercasing and normalizing
 * every line first. Runs of whitespace match loosely, so a query typed with one
 * space still finds text wrapped across a newline.
 */
export function queryMatcher(query: string): RegExp | undefined {
  const bare = query.trim().toLowerCase().normalize("NFD").replace(DIACRITICS, "");
  if (!bare) return undefined;
  const pattern = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+|[a-z]/g, (token) => {
    if (token.trim() === "") return "\\s+";
    const variants = ACCENTS[token];
    return variants ? `[${variants}]` : token;
  });
  return new RegExp(pattern, "i"); // never /g — .test() would carry lastIndex between calls
}

const cache = new Map<string, TranscriptMatch[]>();

/**
 * Up to `limit` matches in a session file, oldest first. A missing or
 * unreadable file yields nothing: search is a convenience over whatever is on
 * disk, and a thread whose transcript is gone still exists.
 */
export async function searchTranscript(sessionFile: string, matcher: RegExp, limit: number): Promise<TranscriptMatch[]> {
  let size: number;
  try {
    size = (await stat(sessionFile)).size;
  } catch {
    return [];
  }

  const key = `${sessionFile}\0${size}\0${limit}\0${matcher.source}`;
  const cached = lruTouch(cache, key);
  if (cached) return cached;

  const matches = await scan(sessionFile, matcher, limit);
  cache.set(key, matches);
  if (cache.size > MAX_CACHED_SEARCHES) cache.delete(cache.keys().next().value!);
  return matches;
}

async function scan(sessionFile: string, matcher: RegExp, limit: number): Promise<TranscriptMatch[]> {
  const matches: TranscriptMatch[] = [];
  let handle;
  try {
    handle = await open(sessionFile, "r");
  } catch {
    return matches;
  }
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    // The partial line left over from the previous read. Prepending it is what
    // lets a match straddle a chunk boundary.
    let carry = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK);
      if (!bytesRead) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      const cut = text.lastIndexOf("\n");
      if (cut === -1) {
        carry += text;
        // A line no message would ever be: stop accumulating it, and let the
        // next newline resynchronize. Its tail may produce a spurious block hit,
        // which collect() then discards along with every other non-message line.
        if (carry.length > MAX_LINE) carry = "";
        continue;
      }
      const block = carry + text.slice(0, cut);
      carry = text.slice(cut + 1);
      // One native pass over the whole block. Splitting it into lines — let
      // alone parsing them — only happens for a block that really does match.
      if (matcher.test(block)) {
        for (const line of block.split("\n")) {
          if (!collect(line, matcher, matches, limit)) break;
        }
        if (matches.length >= limit) break;
      }
    }
    if (carry) collect(carry, matcher, matches, limit);
  } finally {
    await handle.close();
  }
  return matches;
}

/** Test one raw JSONL line and record its match. Returns false once full. */
function collect(line: string, matcher: RegExp, matches: TranscriptMatch[], limit: number): boolean {
  if (line && matcher.test(line)) {
    const match = matchOf(line, matcher);
    if (match) matches.push(match);
  }
  return matches.length < limit;
}

function matchOf(line: string, matcher: RegExp): TranscriptMatch | undefined {
  let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined; // a half-written tail line — the next read will have it whole
  }
  const role = entry.message?.role;
  // Only prose. A hit inside a tool result is a hit on a file the agent read,
  // not on something anyone said, and it would bury the real matches.
  if (entry.type !== "message" || (role !== "user" && role !== "assistant")) return undefined;
  const text = contentText(entry.message?.content).trim();
  const hit = matcher.exec(text);
  if (!hit) return undefined; // the query matched the envelope, not the prose
  return { role, timestamp: entry.timestamp, snippet: clip(text, hit.index, hit[0].length) };
}

/** The hit with some room around it, cut at the nearest space so a snippet
 *  doesn't start mid-word, and marked with ellipses when text was dropped. */
function clip(text: string, at: number, length: number): string {
  let start = Math.max(0, at - SNIPPET_RADIUS);
  let end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > at + length) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

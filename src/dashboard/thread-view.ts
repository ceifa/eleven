import { z } from "zod";
import { isChannelSessionKey } from "../config.ts";
import type { Gateway } from "../gateway.ts";
import { addSample, cacheWasteOf, emptyBucket, promptTokens, readSessionUsage } from "../threads/usage.ts";
import { displayTitle } from "../threads/title.ts";
import { queryMatcher, searchTranscript, type TranscriptMatch } from "../threads/search.ts";
import { findModel } from "../agent/pi.ts";
import type { DashboardContext } from "./context.ts";
import { ApiError } from "./http.ts";

// Search bounds. A query answers with the newest matching threads and stops
// there; snippets are capped per thread so the response stays a few kilobytes
// however long the conversations are.
const SEARCH_THREAD_LIMIT = 40;
const SEARCH_SNIPPETS = 3;
const SEARCH_SCAN_LIMIT = 400;
const SEARCH_BATCH = 8;

export type ThreadViews = ReturnType<typeof threadViews>;

/** Threads as the API describes them: looking one up, the card a list shows,
 *  the filtered and searched list. Nothing here holds state. */
export function threadViews({ gateway, identityOf }: DashboardContext) {
  function resolveThreadRef(ref: string) {
    const exact = gateway.threads.get(ref);
    if (exact) return exact;
    const matches = gateway.threads.list().filter((thread) => thread.id.startsWith(ref));
    if (matches.length === 0) throw new ApiError(404, `thread ${ref} not found`);
    if (matches.length > 1) throw new ApiError(409, `thread prefix ${ref} is ambiguous`);
    return matches[0];
  }

  /** A thread as the API describes it. `sessionFile` is an absolute path nobody
   *  but the detail view reads, and it is a fifth of a full list read — so the
   *  list leaves it out (and stops handing filesystem layout to a tunnel). */
  function threadView(thread: ReturnType<Gateway["threads"]["list"]>[number], { detail = false } = {}) {
    const current = gateway.threads.isCurrent(thread.id);
    const running = gateway.isThreadRunning(thread.id);
    const identity = identityOf(thread.sessionKey);
    const source = thread.sessionKey.split(":", 1)[0];
    return {
      ...thread,
      title: displayTitle(thread.title),
      sessionFile: detail ? thread.sessionFile : undefined,
      current,
      running,
      delivery: gateway.pending.replyStatus(thread.sessionKey),
      state: running ? "running" : current ? "current" : "old",
      source,
      // Whether a turn may be typed into this thread from here. See composable().
      composable: composable(thread.sessionKey),
      conversation: identity.label,
      // What the list puts on the card: the topic, group or person, which is
      // how you actually recognize a thread — the label is the tooltip.
      conversationName: identity.name,
      conversationContext: identity.context,
      // The face on the card: a picture the daemon serves, over the initial it
      // falls back to — tinted with the topic's colour when Telegram gave one.
      avatar: identity.picture && {
        kind: identity.picture.kind,
        src: `/api/avatars/${encodeURIComponent(thread.sessionKey)}?v=${encodeURIComponent(identity.picture.version)}`,
      },
      avatarColor: identity.color === undefined ? undefined : `#${identity.color.toString(16).padStart(6, "0")}`,
    };
  }

  /**
   * Whether the composer may run a turn in this thread.
   *
   * A thread belongs to the conversation it was born in. The dashboard's turns
   * are not channel turns: they carry no channel's tool and nothing delivers them,
   * so a reply typed into a Telegram thread from here lands in the transcript
   * and never reaches the chat — a question and an answer that the person on the
   * other end cannot see, in the middle of a conversation they are still
   * reading. The dashboard's own threads (and the CLI's, whose caller is long
   * gone) have no such other end.
   *
   * Reading, stopping a runaway turn, rotating the conversation and delivering
   * literal text (/send, which does reach the chat) all stay open.
   */
  function composable(sessionKey: string): boolean {
    return !isChannelSessionKey(sessionKey);
  }

  async function listThreadViews(url: URL) {
    const workspace = url.searchParams.get("workspace") ?? undefined;
    const channel = url.searchParams.get("channel");
    const currentOnly = url.searchParams.get("current") === "1";
    const runningOnly = url.searchParams.get("running") === "1";
    const sinceValue = url.searchParams.get("since");
    const since = sinceValue === null ? undefined : Number(sinceValue);
    if (since !== undefined && (!Number.isFinite(since) || since <= 0)) throw new ApiError(400, "invalid since value");
    const limitValue = url.searchParams.get("limit");
    const rawLimit = limitValue === null ? undefined : Number(limitValue);
    if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit <= 0)) throw new ApiError(400, "limit must be a positive integer");
    const limit = rawLimit;
    let threads = gateway.threads.list(workspace).map((thread) => threadView(thread));
    if (channel) threads = threads.filter((thread) => thread.source === channel);
    if (currentOnly) threads = threads.filter((thread) => thread.current);
    if (runningOnly) threads = threads.filter((thread) => thread.running);
    if (since !== undefined) threads = threads.filter((thread) => thread.lastActivityAt >= since);
    const query = url.searchParams.get("q")?.trim();
    if (query) {
      z.string().max(200).parse(query);
      return searchThreads(threads, query, Math.min(limit ?? SEARCH_THREAD_LIMIT, 100));
    }
    return limit ? threads.slice(0, limit) : threads;
  }

  /**
   * Threads whose title, conversation or transcript contains the query, newest
   * first, each carrying the snippets that matched.
   *
   * The scan stops the moment `limit` threads have matched. Since the list
   * arrives ordered by last activity, that answer is exactly the top of the
   * result the user is looking at, and the rest of the archive is never opened —
   * which is what keeps a search over hundreds of sessions cheap.
   */
  async function searchThreads(threads: ReturnType<typeof threadView>[], query: string, limit: number) {
    const matcher = queryMatcher(query);
    if (!matcher) return threads.slice(0, limit);
    const found: (ReturnType<typeof threadView> & { matches: TranscriptMatch[] })[] = [];
    const pool = threads.slice(0, SEARCH_SCAN_LIMIT);
    for (let index = 0; index < pool.length && found.length < limit; index += SEARCH_BATCH) {
      // A batch at a time: local files answer in parallel, but overshooting the
      // limit by a few reads is far cheaper than scanning the whole archive.
      const batch = await Promise.all(
        pool.slice(index, index + SEARCH_BATCH).map(async (thread) => {
          const named = matcher.test(`${thread.title ?? ""}\n${thread.conversation}\n${thread.workspace}`);
          const sessionFile = gateway.threads.get(thread.id)?.sessionFile;
          const matches = sessionFile ? await searchTranscript(sessionFile, matcher, SEARCH_SNIPPETS) : [];
          return matches.length || named ? { ...thread, matches } : undefined;
        }),
      );
      for (const thread of batch) if (thread) found.push(thread);
    }
    return found.slice(0, limit);
  }

  return { resolveThreadRef, threadView, composable, listThreadViews };
}

/**
 * What one conversation has cost so far, plus how full its context window was
 * on the last response — the number worth watching live, because it says how
 * close the thread is to a compaction, which is itself a paid call.
 *
 * That reading is only offered when the last response was one request. A nested
 * runtime persists one row per *turn*, summing every request its private tool
 * loop made, and a sum of prompts is not the size of a window.
 */
export function threadUsage(samples: Awaited<ReturnType<typeof readSessionUsage>>, effectiveModel: string | undefined) {
  if (!samples.length) return undefined;
  const bucket = emptyBucket();
  for (const sample of samples) addSample(bucket, sample);
  const last = samples[samples.length - 1];
  // A compaction carries no model of its own, so fall back to the sequence's
  // current head rather than reporting a window of unknown size.
  const contextWindow = findModel(last.model || effectiveModel || "")?.contextWindow;
  const fill = last.nested || !contextWindow ? undefined : { lastPromptTokens: promptTokens(last), contextWindow };
  return { ...bucket, waste: cacheWasteOf(samples), lastAt: last.at, lastModel: last.model, ...fill };
}

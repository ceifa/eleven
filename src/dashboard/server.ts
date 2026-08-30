import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, extname, normalize, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { WebSocketServer, WebSocket } from "ws";
import type { ImageContent } from "@earendil-works/pi-ai";
import { BUILTIN_TOOLS, CHANNEL_TYPES, DEFAULT_REASONING, isUnresolved, REASONING_LEVELS, runtimeTools, type ConfigStore, type ElevenConfig } from "../config.ts";
import { collectProviderUsage } from "../provider-usage.ts";
import { parseTelegramSessionKey } from "../channels/telegram/session-key.ts";
import { BUILTIN_SYSTEM_PROMPT } from "../agent/system-prompt.ts";
import { listWorkspaceSkills } from "../agent/runner.ts";
import type { Gateway } from "../gateway.ts";
import type { TelegramChannel } from "../channels/telegram/index.ts";
import { collectStoredMedia, formatInboundBody, resolveMediaPath, saveInboundMedia, validMime, type StoredAttachment } from "../media-store.ts";
import { readThreadTimeline, readToolResult } from "../threads/reader.ts";
import { addSample, buildUsageReport, cacheWasteOf, emptyBucket, promptTokens, readSessionUsage, startOfLocalDay } from "../threads/usage.ts";
import { conversationIdentity } from "../threads/conversation.ts";
import { queryMatcher, searchTranscript, type TranscriptMatch } from "../threads/search.ts";
import { findModel, modelRuntime } from "../agent/pi.ts";
import { logger } from "../log.ts";

const log = logger("dashboard");
const PUBLIC_DIR = join(import.meta.dirname, "public");
const SHELL_FILES = ["index.html", "app.js", "dom.js", "live-turn.js", "markdown.js", "message-display.js", "waveform.js", "style.css"];
// Newest mtime among the app-shell files, read once: new assets arrive with a
// new daemon, and a stat per socket would buy nothing.
const SHELL_VERSION = Math.max(
  ...SHELL_FILES.map((name) => {
    try {
      return statSync(join(PUBLIC_DIR, name)).mtimeMs;
    } catch {
      return 0;
    }
  }),
);
// One Telegram rich-message request: avoids ambiguous partial delivery and
// duplicate prefixes when a multi-chunk send fails midway.
const MAX_OUTBOUND_MESSAGE_CHARS = 32_000;
// How much of a message the activity broadcast carries. Enough to read the
// bubble; the transcript refetch that follows replaces it with the real thing.
const ACTIVITY_PREVIEW_CHARS = 4_000;
// Search bounds. A query answers with the newest matching threads and stops
// there; snippets are capped per thread so the response stays a few kilobytes
// however long the conversations are.
const SEARCH_THREAD_LIMIT = 40;
const SEARCH_SNIPPETS = 3;
const SEARCH_SCAN_LIMIT = 400;
const SEARCH_BATCH = 8;
// Token accounting bounds. The default window is a month because that is also
// roughly how long session files survive gc; the ceiling is only there so a
// hand-typed query can't ask for a window arithmetic would overflow.
const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 3650;
const USAGE_THREAD_LIMIT = 20;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
// What a composer may upload in one file. Telegram tops out at 20 MB; this is
// the same order of magnitude, and the ceiling a browser is held to so a slip of
// the finger on a video file can't stream gigabytes into the state directory.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Types a stored attachment may be rendered as, inside the dashboard's own
// origin. Everything else is downloaded instead: an uploaded .html or .svg
// served inline would be a script running as the page that can drive the agent.
// (image/svg+xml is deliberately absent from this list for that reason.)
const INLINE_MEDIA = /^(image\/(png|jpeg|gif|webp|avif)|audio\/|video\/)/;
// What is worth compressing: everything the dashboard serves that is text.
// Fonts are woff2, which is brotli already — running it again costs CPU to save
// nothing.
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
// Below this a compressed body saves less than the headers and CPU it costs.
const COMPRESS_MIN_BYTES = 1024;
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
// Static assets are compressed once per daemon, so they get the expensive
// setting; API payloads are compressed per response, where quality 5 is the
// knee of the curve (near-gzip cost, better than gzip ratio).
const STATIC_BROTLI = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } };
const DYNAMIC_BROTLI = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } };
// The app shell is html/js/css and hundreds of kilobytes of it; over a tunnel
// that is the whole difference between a snappy dashboard and a sluggish one.
type Encoding = "br" | "gzip";
interface Asset {
  body: Buffer;
  /** Pre-compressed variants, empty for anything already compressed. */
  encoded: Map<Encoding, Buffer>;
  etag: string;
  type: string;
  immutable: boolean;
}

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Dashboard {
  close(): Promise<void>;
}

export function startDashboard(config: ConfigStore, gateway: Gateway, telegram: TelegramChannel): Dashboard {
  const server = createServer((req, res) => void route(req, res).catch((error) => fail(res, 500, error)));
  const wss = new WebSocketServer({ server, path: "/ws" });
  const cliRuns = new Map<string, { status: "running" | "done" | "error"; result?: unknown; error?: string }>();

  const send = (message: string) => {
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  };

  // Streamed deltas arrive dozens of times per second — coalesce them into
  // ~75ms frames per thread instead of one WS message (and stringify) each.
  const pendingDeltas = new Map<string, string>();
  let deltaTimer: NodeJS.Timeout | undefined;
  const flushDeltas = () => {
    clearTimeout(deltaTimer);
    deltaTimer = undefined;
    for (const [threadId, delta] of pendingDeltas) send(JSON.stringify({ type: "delta", threadId, delta }));
    pendingDeltas.clear();
  };

  const broadcast = (payload: { type: string; threadId?: string; delta?: string } & Record<string, unknown>) => {
    if (wss.clients.size === 0) return; // nobody watching — skip the stringify too
    if (payload.type === "delta") {
      pendingDeltas.set(payload.threadId!, (pendingDeltas.get(payload.threadId!) ?? "") + payload.delta);
      deltaTimer ??= setTimeout(flushDeltas, 75);
      return;
    }
    flushDeltas(); // keep deltas ordered before turn-done and friends
    send(JSON.stringify(payload));
  };

  // Heartbeat so clients can detect half-open sockets (e.g. after a daemon
  // kill) — runs only while someone is connected, so an idle daemon stays idle.
  let heartbeat: NodeJS.Timeout | undefined;
  // An unhandled 'error' on a ws socket (or the server) throws out of the
  // EventEmitter — with no uncaughtException handler that kills the daemon. A
  // client dropping uncleanly (laptop sleep, tunnel hiccup) is routine, so log
  // and move on; the 'close' that follows does the cleanup.
  wss.on("error", (error) => log.warn(`websocket server error: ${error}`));
  wss.on("connection", (socket) => {
    socket.on("error", (error) => log.warn(`websocket client error: ${error}`));
    // Which app shell this daemon serves. A tab left open across a restart keeps
    // running the old html/js against the new API, and a field renamed on one
    // side throws mid-render on the other; the page compares this across
    // reconnects and reloads itself when it changed.
    socket.send(JSON.stringify({ type: "hello", shell: SHELL_VERSION }));
    heartbeat ??= setInterval(() => broadcast({ type: "ping" }), 20_000);
    socket.on("close", () => {
      if (wss.clients.size === 0) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
  });

  gateway.on("delta", (event) => broadcast({ type: "delta", ...event }));
  gateway.on("provider-request", (event) => broadcast({ type: "provider-request", ...event }));
  gateway.on("tool-call", (event) => broadcast({ type: "tool-call", ...event }));
  // The whole board, not the event that changed it — same shape the catch-up
  // endpoint serves, so the client stores it instead of replaying anything.
  gateway.on("task-activity", (event) => broadcast({ type: "task-activity", ...event }));
  gateway.on("turn-start", (event) => broadcast({ type: "turn-start", ...event }));
  gateway.on("turn-done", (event) => broadcast({ type: "turn-done", ...event }));
  gateway.on("turn-error", (event) => broadcast({ type: "turn-error", ...event }));
  gateway.on("turn-rewound", (event) => broadcast({ type: "turn-rewound", ...event }));
  // A conversation rotated — from here, from Telegram's /new, or in another tab.
  gateway.on("thread-started", (event) => broadcast({ type: "thread-started", ...event }));
  // The message itself rides along (clipped — the transcript refetch has the
  // full text): a page watching the thread can show an inbound Telegram message
  // the moment it lands, instead of only after the turn finishes.
  gateway.on("thread-activity", ({ thread, direction, text }) =>
    broadcast({
      type: "activity",
      threadId: thread.id,
      workspace: thread.workspace,
      direction,
      text: typeof text === "string" ? text.slice(0, ACTIVITY_PREVIEW_CHARS) : undefined,
    }),
  );
  telegram.pairing.on("request", (request) => broadcast({ type: "pairing", request }));
  // The daemon itself mutates config (pairing approvals, group/topic auto-registry) —
  // let open dashboards refresh instead of showing stale state.
  config.on("change", () => broadcast({ type: "config-changed" }));

  function resolveThreadRef(ref: string) {
    const exact = gateway.threads.get(ref);
    if (exact) return exact;
    const matches = gateway.threads.list().filter((thread) => thread.id.startsWith(ref));
    if (matches.length === 0) throw new ApiError(404, `thread ${ref} not found`);
    if (matches.length > 1) throw new ApiError(409, `thread prefix ${ref} is ambiguous`);
    return matches[0];
  }

  // A list read resolves an identity per thread, and there are hundreds of
  // them — so the channel array is derived once per config generation instead
  // of being rebuilt for every single thread.
  const channelsByConfig = new WeakMap<object, ReturnType<typeof config.channels>[number]["channel"][]>();
  function identityOf(sessionKey: string) {
    const entries = config.channels();
    let channels = channelsByConfig.get(entries);
    if (!channels) {
      channels = entries.map(({ channel }) => channel);
      channelsByConfig.set(entries, channels);
    }
    return conversationIdentity(sessionKey, channels);
  }

  /** The model scopes a Telegram conversation runs under, most specific first
   * (topic, then owner — the group, or the person when it is a DM). Read-only
   * here: what the detail view reports as the thread's effective model. Turns in
   * these threads are the channel's own, and it resolves this itself. */
  function channelModelScopes(sessionKey: string) {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target) return [];
    const channel = config.channels().find((entry) => entry.channel.name === target.channel)?.channel;
    const key = String(target.chatId);
    const owner = target.chatId > 0 ? channel?.users?.[key] : channel?.groups?.[key];
    const topic = target.topic !== undefined ? owner?.topics?.[String(target.topic)] : undefined;
    return [topic, owner];
  }

  /** A thread as the API describes it. `sessionFile` is an absolute path nobody
   *  but the detail view reads, and it is a fifth of a full list read — so the
   *  list leaves it out (and stops handing filesystem layout to a tunnel). */
  function threadView(thread: ReturnType<typeof gateway.threads.list>[number], { detail = false } = {}) {
    const current = gateway.threads.isCurrent(thread.id);
    const running = gateway.isThreadRunning(thread.id);
    const identity = identityOf(thread.sessionKey);
    const source = thread.sessionKey.split(":", 1)[0];
    return {
      ...thread,
      sessionFile: detail ? thread.sessionFile : undefined,
      current,
      running,
      state: running ? "running" : current ? "current" : "old",
      source,
      // Whether a turn may be typed into this thread from here. See composable().
      composable: composable(thread.sessionKey),
      conversation: identity.label,
      // What the list puts on the card: the topic, group or person, which is
      // how you actually recognize a thread — the label is the tooltip.
      conversationName: identity.name,
      conversationContext: identity.context,
    };
  }

  /**
   * Whether the composer may run a turn in this thread.
   *
   * A thread belongs to the conversation it was born in. The dashboard's turns
   * are not channel turns: they carry no channel tool and nothing delivers them,
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
    return !(CHANNEL_TYPES as readonly string[]).includes(sessionKey.split(":", 1)[0]);
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
    if (query) return searchThreads(threads, query, limit ?? SEARCH_THREAD_LIMIT);
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
          const matches = thread.sessionFile ? await searchTranscript(thread.sessionFile, matcher, SEARCH_SNIPPETS) : [];
          return matches.length || named ? { ...thread, matches } : undefined;
        }),
      );
      for (const thread of batch) if (thread) found.push(thread);
    }
    return found.slice(0, limit);
  }

  async function workspaceView(name: string, includeSkills: boolean) {
    const workspace = config.resolved.workspaces[name];
    if (!workspace) throw new Error(`workspace ${name} not found`);
    const bots = new Map(telegram.status().map((bot) => [bot.name, bot]));
    const threads = gateway.threads.list(name);
    const channels = (workspace.channels ?? []).map((channel) => {
      const bot = bots.get(channel.name);
      return {
        type: channel.type,
        name: channel.name,
        username: bot?.username,
        connected: bot?.connected ?? false,
        users: Object.keys(channel.users ?? {}).length,
        groups: Object.keys(channel.groups ?? {}).length,
      };
    });
    const chain = config.turnModels(undefined, [workspace]);
    const result = {
      name,
      path: workspace.path,
      pathExists: existsSync(workspace.path),
      model: chain[0]?.model ?? "",
      modelSource: workspace.models?.length ? "workspace" : "inherited",
      fallbacks: chain.slice(1).map((entry) => entry.model),
      tools: workspace.tools ?? [...BUILTIN_TOOLS],
      customPrompt: workspace.systemPrompt !== undefined,
      channels,
      threads: {
        total: threads.length,
        current: threads.filter((thread) => gateway.threads.isCurrent(thread.id)).length,
        running: threads.filter((thread) => gateway.isThreadRunning(thread.id)).length,
      },
      session: {
        idleDays: config.resolved.session?.idleDays ?? 7,
        retentionDays: config.resolved.session?.retentionDays ?? 30,
      },
    };
    if (!includeSkills) return result;
    const skills = existsSync(workspace.path) ? await listWorkspaceSkills(workspace.path) : [];
    return { ...result, skills: skills.map(({ name, description }) => ({ name, description })) };
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/")) return api(req, res, url);

    // SPA fallback: unknown paths render the app shell.
    const asset = (await loadAsset(path === "/" ? "/index.html" : path)) ?? (await loadAsset("/index.html"));
    if (!asset) return fail(res, 404, new Error("public assets are missing"));
    return sendAsset(req, res, asset);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.slice(4);
    const method = req.method ?? "GET";
    const send = (status: number, payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload) ?? "null");
      const headers: Record<string, string> = { "content-type": "application/json" };
      // Reads get an ETag: the dashboard refetches the thread list on every
      // event that could have touched it, and most of those answers are the
      // bytes it already holds — that costs an empty 304 instead of the list.
      if (method === "GET" && status === 200) {
        headers.etag = etagOf(body);
        headers["cache-control"] = "no-cache";
        headers.vary = "accept-encoding";
        if (isFresh(req, headers.etag)) {
          res.writeHead(304, headers);
          return res.end();
        }
      }
      return deliver(req, res, status, headers, body);
    };

    // CSRF guard: state-changing requests must be same-origin. A hostile page
    // can fire a no-preflight cross-origin POST at 127.0.0.1 (or the tunnel) and
    // drive the bash/edit/write-capable agent; browsers always attach Origin to
    // such requests, so a mismatch with Host is the tell. Non-browser clients
    // (curl, the agent itself) send no Origin and are unaffected.
    if (method !== "GET" && method !== "HEAD" && crossOrigin(req)) {
      return send(403, { error: "cross-origin request refused" });
    }

    try {
      if (method === "GET" && path === "/status") {
        const bots = telegram.status();
        const configuredChannels = config.channels();
        const healthyNames = new Set(bots.filter((bot) => bot.connected).map((bot) => bot.name));
        const threads = gateway.threads.list();
        return send(200, {
          service: "running",
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          dashboard: config.resolved.dashboard,
          workspaces: Object.keys(config.resolved.workspaces).length,
          channels: {
            total: configuredChannels.length,
            healthy: configuredChannels.filter(({ channel }) => healthyNames.has(channel.name)).length,
          },
          threads: {
            total: threads.length,
            current: threads.filter((thread) => gateway.threads.isCurrent(thread.id)).length,
            running: threads.filter((thread) => gateway.isThreadRunning(thread.id)).length,
          },
        });
      }
      if (method === "GET" && path === "/workspaces") {
        return send(200, await Promise.all(Object.keys(config.resolved.workspaces).map((name) => workspaceView(name, false))));
      }
      if (method === "GET" && path.match(/^\/workspaces\/[^/]+$/)) {
        return send(200, await workspaceView(decodeURIComponent(path.split("/")[2]), true));
      }
      if (method === "GET" && path === "/overview") {
        return send(200, {
          bots: telegram.status(),
          pairing: telegram.pairing.list(),
          // Names only: the pages that edit a workspace read /config for it,
          // and the ones that merely offer a choice (the filter, the new-thread
          // dialog) never needed anything else.
          workspaces: Object.keys(config.resolved.workspaces),
          tools: BUILTIN_TOOLS,
          reasoningLevels: REASONING_LEVELS,
          defaultReasoning: DEFAULT_REASONING,
          channelTypes: CHANNEL_TYPES,
          builtinSystemPrompt: BUILTIN_SYSTEM_PROMPT,
        });
      }
      if (method === "GET" && path === "/config") return send(200, redactTokens(config.raw));
      if (method === "PUT" && path === "/config") {
        const next = (await body(req)) as ElevenConfig;
        restoreTokens(next, config.raw);
        config.save(next);
        return send(200, redactTokens(config.raw));
      }
      if (method === "GET" && path === "/threads") {
        return send(200, await listThreadViews(url));
      }
      // An attachment on its way to a turn. The body is the file itself — a
      // multipart parser would buy nothing here, since one upload is one file.
      // The answer is a receipt: the stored name, which is the only handle the
      // page ever holds (the absolute path stays on this side of the tunnel).
      if (method === "POST" && path === "/media") {
        const bytes = await rawBody(req, MAX_UPLOAD_BYTES);
        if (!bytes.length) throw new ApiError(400, "upload is empty");
        const name = url.searchParams.get("name") ?? "attachment";
        const stored = await saveInboundMedia(bytes, name);
        return send(201, { id: basename(stored), bytes: bytes.length, mime: validMime(req.headers["content-type"]) });
      }
      // Reading one back: how the transcript shows a photo instead of a path,
      // for anything attached here *or* sent from a channel. The caller says how
      // it wants the bytes typed, and only the renderable types are honored —
      // the rest is served as an opaque download, never as a document in this
      // origin.
      if (method === "GET" && path.startsWith("/media/")) {
        const file = resolveMediaPath(decodeURIComponent(path.slice("/media/".length)));
        let bytes: Buffer | undefined;
        try {
          bytes = file ? await readFile(file) : undefined;
        } catch {
          bytes = undefined;
        }
        if (!bytes) return send(404, { error: "media not found" });
        const declared = validMime(url.searchParams.get("type") ?? undefined) ?? "";
        const inline = INLINE_MEDIA.test(declared);
        return deliver(req, res, 200, {
          "content-type": inline ? declared : "application/octet-stream",
          "content-disposition": inline ? "inline" : "attachment",
          "x-content-type-options": "nosniff",
          // Stored names are unique per file and their contents never change.
          "cache-control": "private, max-age=31536000, immutable",
        }, bytes);
      }
      if (method === "GET" && path.match(/^\/threads\/[^/]+\/run$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const run = cliRuns.get(thread.id);
        if (!run) throw new ApiError(404, "no CLI run is tracked for this thread");
        return send(200, run);
      }
      if (method === "GET" && path.match(/^\/threads\/[^/]+$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const [timeline, requests, samples] = await Promise.all([
          thread.sessionFile ? readThreadTimeline(thread.sessionFile) : [],
          gateway.requests.list(thread.id),
          thread.sessionFile ? readSessionUsage(thread.sessionFile) : [],
        ]);
        const messages = timeline.flatMap((item) => (item.kind === "message" ? [item] : []));
        const workspace = config.resolved.workspaces[thread.workspace];
        const effectiveModel = workspace
          ? config.turnModels(thread.model, [...channelModelScopes(thread.sessionKey), workspace])
              .map((candidate) => candidate.model)
              .find((ref) => findModel(ref))
          : undefined;
        return send(200, {
          thread: {
            ...threadView(thread, { detail: true }),
            effectiveModel,
            lastModel: requests.at(-1)?.model,
            messages: messages.length,
            turns: messages.filter((message) => message.role === "user").length,
            usage: threadUsage(samples, effectiveModel),
          },
          timeline,
          requests,
          // Catch-up for a page opened mid-turn: what the running turn already
          // did, in order (WS events only reach pages already connected).
          live: gateway.liveTurn(thread.id),
        });
      }
      if (method === "GET" && path.match(/^\/requests\/[^/]+\/[^/]+$/)) {
        const [, , threadId, requestId] = path.split("/");
        const entry = await gateway.requests.get(threadId, requestId);
        if (!entry) return send(404, { error: "request not found" });
        return send(200, entry);
      }
      // Tool-call output, fetched on click. The call id goes in a query param
      // (it can contain "|" and other path-hostile characters).
      if (method === "GET" && path.match(/^\/threads\/[^/]+\/toolresult$/)) {
        const thread = gateway.threads.get(path.split("/")[2]);
        const call = url.searchParams.get("call");
        if (!thread?.sessionFile || !call) return send(404, { error: "not found" });
        const result = await readToolResult(thread.sessionFile, call);
        if (!result) return send(404, { error: "result not found" });
        return send(200, result);
      }
      if (method === "DELETE" && path.match(/^\/threads\/[^/]+$/)) {
        const id = path.split("/")[2];
        const workspace = gateway.threads.get(id)?.workspace;
        if (!(await gateway.deleteThread(id))) return send(404, { error: "thread not found" });
        // Other open dashboards drop the thread from their list too.
        broadcast({ type: "thread-deleted", threadId: id, workspace });
        return send(200, { ok: true });
      }
      if (method === "POST" && path === "/threads") {
        const request = (await body(req)) as { workspace: string; text: string; source?: string; attachments?: unknown };
        const { workspace } = request;
        if (!config.resolved.workspaces[workspace]) throw new Error(`workspace ${workspace} not found`);
        const { text, images } = await composeInbound(request.text, request.attachments);
        if (!text.trim() && !images.length) throw new Error("message is required");
        const source = request.source === "cli" ? "cli" : "dashboard";
        const sessionKey = `${source}:${workspace}:${randomUUID()}`;
        const thread = gateway.newThread(sessionKey, workspace);
        if (source === "cli") {
          cliRuns.set(thread.id, { status: "running" });
          while (cliRuns.size > 100) {
            const evictable = [...cliRuns].find(([, run]) => run.status !== "running")?.[0];
            if (!evictable) break;
            cliRuns.delete(evictable);
          }
          void runLocalTurn(sessionKey, text, source, images).then(
            (result) => cliRuns.set(thread.id, { status: "done", result }),
            (error) => cliRuns.set(thread.id, { status: "error", error: error instanceof Error ? error.message : String(error) }),
          );
          return send(201, threadView(thread));
        }
        void runLocalTurn(sessionKey, text, source, images).catch(() => {});
        return send(201, thread);
      }
      // The dashboard's stop button — Telegram's /stop for the thread you are
      // looking at. Buffered input goes with it: a burst still waiting out its
      // quiet window would otherwise start a turn a second after the stop.
      if (method === "POST" && path.match(/^\/threads\/[^/]+\/interrupt$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const dropped = gateway.threads.isCurrent(thread.id) && telegram.discardPending(thread.sessionKey);
        const stopped = await gateway.interruptThread(thread.id);
        return send(200, { stopped, dropped });
      }
      // The dashboard's /new. The launcher starts a thread in a conversation of
      // its own, which is no use when what you want is a fresh start *here* —
      // in the Telegram topic (or DM) this thread belongs to, so the agent's
      // replies keep landing where the conversation lives.
      if (method === "POST" && path.match(/^\/threads\/[^/]+\/new$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        // Fresh means fresh, exactly as in Telegram: buffered input and the
        // in-flight turn belong to the thread being left behind.
        telegram.discardPending(thread.sessionKey);
        await gateway.interrupt(thread.sessionKey);
        const started = gateway.newThread(thread.sessionKey, thread.workspace);
        return send(201, threadView(started));
      }
      if (method === "POST" && path.match(/^\/threads\/[^/]+\/message$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        if (!composable(thread.sessionKey)) {
          throw new ApiError(409, `this thread lives in ${identityOf(thread.sessionKey).label}. Answer it there, or start a thread of your own here.`);
        }
        const request = (await body(req)) as { text: string; attachments?: unknown };
        const { text, images } = await composeInbound(request.text, request.attachments);
        if (!text.trim() && !images.length) throw new Error("message is required");
        void runLocalTurn(thread.sessionKey, text, "dashboard", images).catch(() => {});
        // The composer uses this exact body to replace its upload-receipt
        // preview. It includes absolute paths and voice transcription — exactly
        // what the agent received, and exactly what ⚡ promises to expose.
        return send(202, { ok: true, message: text });
      }
      if (method === "POST" && path.match(/^\/threads\/[^/]+\/send$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const { text } = (await body(req)) as { text: string };
        if (!text?.trim()) throw new Error("message is required");
        if (text.length > MAX_OUTBOUND_MESSAGE_CHARS) throw new ApiError(413, "message is too large");
        if (!gateway.threads.isCurrent(thread.id)) {
          const current = gateway.threads.current(thread.sessionKey);
          throw new Error(`thread is old${current ? `; current thread is ${current.id.slice(0, 8)}` : ""}`);
        }
        const delivery = await gateway.deliverOutbound(thread.id, text, () => telegram.sendToSession(thread.sessionKey, text));
        return send(200, { ok: true, threadId: thread.id, ...delivery });
      }
      if (method === "POST" && path.match(/^\/pairing\/[^/]+\/(approve|deny)$/)) {
        const [, , requestId, action] = path.split("/");
        const request = action === "approve" ? await telegram.approvePairing(requestId) : telegram.denyPairing(requestId);
        return send(200, request);
      }
      if (method === "GET" && path === "/models") {
        // The full catalog, with everything the model picker needs to filter:
        // which runtime serves the ref (and thus which tools exist there),
        // whether it can reason, and how much context it carries.
        const available = await modelRuntime.getAvailable();
        return send(200, available
          .map((m) => ({
            ref: `${m.provider}/${m.id}`,
            name: m.name,
            provider: m.provider,
            reasoning: m.reasoning,
            contextWindow: m.contextWindow,
            tools: runtimeTools(m.provider),
          }))
          .sort((a, b) => a.ref.localeCompare(b.ref)));
      }
      // Subscription quotas for every provider the sequences reference. Network
      // calls behind it are slow — the UI fetches this after first paint.
      if (method === "GET" && path === "/usage") {
        const providers = [...new Set(config.configuredModelRefs().map((ref) => ref.split("/", 1)[0]))];
        return send(200, await collectProviderUsage(providers));
      }
      // The other half of the question the endpoint above answers: not what a
      // provider has left, but what was spent getting there — which is the only
      // half that exists at all for a provider billed per use.
      //
      // Read off the session transcripts every time: a full history is about a
      // second of scanning, so there is no index to keep honest. Only what is
      // still on disk can be counted — gc deletes session files on a retention
      // timer, and `oldestAt` says where the data actually begins.
      if (method === "GET" && path === "/usage/tokens") {
        const raw = url.searchParams.get("days");
        const days = raw === null ? DEFAULT_USAGE_DAYS : Number(raw);
        if (!Number.isInteger(days) || days <= 0 || days > MAX_USAGE_DAYS) throw new ApiError(400, "days must be an integer between 1 and 3650");
        const report = await buildUsageReport(
          gateway.threads.list().map((thread) => ({
            id: thread.id,
            sessionFile: thread.sessionFile,
            title: thread.title,
            workspace: thread.workspace,
            conversation: identityOf(thread.sessionKey).name,
          })),
          startOfLocalDay(Date.now(), days - 1),
        );
        // The long tail of threads is dozens of rows nobody reads; the total
        // above already counts them.
        return send(200, { ...report, days, byThread: report.byThread.slice(0, USAGE_THREAD_LIMIT) });
      }
      if (method === "GET" && path === "/providers") {
        const configured = new Set(
          config.resolved.models.map((entry) => entry.model.split("/")[0]).filter(Boolean),
        );
        for (const model of await modelRuntime.getAvailable()) configured.add(model.provider);
        return send(
          200,
          [...configured].sort().map((provider) => ({ provider, ...authStatus(provider) })),
        );
      }
      return send(404, { error: "not found" });
    } catch (error) {
      log.warn(`api ${method} ${path}: ${error}`);
      const status = error instanceof ApiError ? error.status : 400;
      return send(status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The prompt a composer's submission becomes: its text, the note per uploaded
   * file so the agent can open it, the transcript of anything recorded — the
   * same body an inbound Telegram message produces, so a turn cannot tell the
   * two apart. Images additionally ride along for the model to look at.
   */
  async function composeInbound(text: unknown, attachments: unknown) {
    const refs = Array.isArray(attachments)
      ? attachments.flatMap((entry): StoredAttachment[] => {
          const { id, mime, voice } = (entry ?? {}) as Record<string, unknown>;
          return typeof id === "string" ? [{ id, mime: typeof mime === "string" ? mime : undefined, voice: voice === true }] : [];
        })
      : [];
    const userText = typeof text === "string" ? text.trim() : "";
    if (!refs.length) return { text: userText, images: [] };
    const media = await collectStoredMedia(refs, config.resolved.transcription?.command);
    return { text: formatInboundBody(userText, media), images: media.images };
  }

  async function runLocalTurn(sessionKey: string, message: string, source: "dashboard" | "cli", images: ImageContent[] = []) {
    // turn-done/turn-error reach the UI via the gateway's own events.
    try {
      return await gateway.handle({
        sessionKey,
        text: message,
        images: images.length ? images : undefined,
        runtime: {
          channel: source,
          conversation: source === "cli" ? "eleven CLI" : "eleven web dashboard",
          capabilities: ["rich markdown"],
        },
        workspaceHint: gateway.threads.current(sessionKey)?.workspace,
      });
    } catch (error) {
      log.warn(`${source} turn failed: ${error}`);
      throw error;
    }
  }

  function authStatus(provider: string) {
    try {
      const status = modelRuntime.getProviderAuthStatus(provider);
      return { configured: status.configured, source: status.source, label: status.label };
    } catch {
      return { configured: false };
    }
  }

  const { host, port } = config.resolved.dashboard;
  // Read, hash and compress the shell while the daemon boots, so the first
  // browser to arrive doesn't wait on brotli.
  for (const file of SHELL_FILES) void loadAsset(`/${file}`);
  server.listen(port, host, () => log.info(`dashboard on http://${host}:${port}`));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearTimeout(deltaTimer);
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
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
function threadUsage(samples: Awaited<ReturnType<typeof readSessionUsage>>, effectiveModel: string | undefined) {
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

/* ---------- HTTP delivery: caching + compression ---------- */

const etagOf = (body: Buffer) => `"${createHash("sha1").update(body).digest("base64url")}"`;

/** True when the client already holds this exact body. */
function isFresh(req: IncomingMessage, etag: string): boolean {
  const header = req.headers["if-none-match"];
  if (typeof header !== "string") return false;
  return header.split(",").some((tag) => {
    const candidate = tag.trim();
    return candidate === etag || candidate === `W/${etag}` || candidate === "*";
  });
}

/** The best encoding both sides accept, ignoring anything the client disabled
 *  with `;q=0`. Brotli first: it beats gzip by ~20% on this kind of payload. */
function negotiate(req: IncomingMessage, available: Iterable<Encoding> = ["br", "gzip"]): Encoding | undefined {
  const accept = req.headers["accept-encoding"];
  if (typeof accept !== "string") return undefined;
  const offered = new Map(
    accept.split(",").map((part) => {
      const [name, ...params] = part.trim().split(";");
      return [name.trim().toLowerCase(), !params.some((p) => p.replace(/\s/g, "") === "q=0")] as const;
    }),
  );
  for (const encoding of available) if (offered.get(encoding) || (offered.get("*") && offered.get(encoding) !== false)) return encoding;
  return undefined;
}

/** Write a response, compressing it when it is worth it and the client says so. */
async function deliver(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  encoded?: Map<Encoding, Buffer>,
) {
  const compressible = COMPRESSIBLE.test(headers["content-type"] ?? "") && (encoded?.size || body.length >= COMPRESS_MIN_BYTES);
  const encoding = compressible ? negotiate(req, encoded?.size ? [...encoded.keys()] : undefined) : undefined;
  let out = body;
  if (encoding) {
    out = encoded?.get(encoding) ?? (encoding === "br" ? await brotliAsync(body, DYNAMIC_BROTLI) : await gzipAsync(body, { level: 6 }));
    headers["content-encoding"] = encoding;
  }
  // Announced whenever the body could have been compressed, so a shared cache
  // never hands a brotli body to a client that cannot read it.
  if (compressible) headers.vary = "accept-encoding";
  headers["content-length"] = String(out.length);
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : out);
}

// The public dir ships with the daemon and cannot change under it — the same
// assumption SHELL_VERSION already makes. So each file is read, hashed and
// compressed once, and every request after that is answered from memory: no
// disk read, no re-compression, and a revalidation costs an empty 304.
const assets = new Map<string, Promise<Asset | undefined>>();

function loadAsset(file: string): Promise<Asset | undefined> {
  const cached = assets.get(file);
  if (cached) return cached;
  // Misses are not remembered: unknown paths all fall through to the app shell,
  // and caching them would let anyone grow this map without bound.
  const pending = readAsset(file).then((asset) => (asset ? asset : (assets.delete(file), undefined)));
  assets.set(file, pending);
  return pending;
}

async function readAsset(file: string): Promise<Asset | undefined> {
  // Resolve then confine to PUBLIC_DIR. `replaceAll("..","")` was a fragile
  // denylist that also mangled legitimate names containing "..".
  const target = normalize(join(PUBLIC_DIR, file));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) return undefined;
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return undefined;
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const encoded = new Map<Encoding, Buffer>();
  if (COMPRESSIBLE.test(type) && body.length >= COMPRESS_MIN_BYTES) {
    const [br, gz] = await Promise.all([brotliAsync(body, STATIC_BROTLI), gzipAsync(body, { level: 9 })]);
    encoded.set("br", br);
    encoded.set("gzip", gz);
  }
  return { body, encoded, etag: etagOf(body), type, immutable: file.startsWith("/fonts/") };
}

function sendAsset(req: IncomingMessage, res: ServerResponse, asset: Asset) {
  const headers: Record<string, string> = {
    "content-type": asset.type,
    etag: asset.etag,
    // Fonts never change — cache them hard. The app shell (html/js/css) changes
    // with the daemon, so it revalidates; with an ETag that is an empty 304
    // rather than the file again.
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (asset.encoded.size) headers.vary = "accept-encoding";
  if (isFresh(req, asset.etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  return deliver(req, res, 200, headers, asset.body, asset.encoded);
}

const MAX_API_BODY_BYTES = 1024 * 1024;

async function body(req: IncomingMessage): Promise<unknown> {
  const raw = (await rawBody(req, MAX_API_BODY_BYTES)).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Read a request body, refusing anything over `limit` — as early as the
 *  declared length allows, and again as the bytes actually arrive. */
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, "request body too large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new ApiError(413, "request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** True when the request carries an Origin whose host differs from the Host
 * header — i.e. a cross-site request. Absent Origin (non-browser clients) is
 * treated as same-origin: those aren't a CSRF vector. */
function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // malformed Origin → refuse
  }
}

// The dashboard is reachable over a tunnel, so it must never receive real
// channel tokens — echoing them on every read is a needless exposure. Env
// references ($VAR) aren't secrets (just names), so they stay visible; only
// literal tokens are masked.
const SECRET_MASK = "••••••••";

function redactTokens(config: ElevenConfig): ElevenConfig {
  const clone = structuredClone(config);
  for (const workspace of Object.values(clone.workspaces))
    for (const channel of workspace.channels ?? [])
      if (!isUnresolved(channel.token)) channel.token = SECRET_MASK;
  return clone;
}

// The client edits the redacted config and PUTs it back, so a masked token
// means "unchanged" — restore it from disk. Lookup stays inside the same
// workspace: by name first, then by position, so a renamed channel keeps its
// token. A mask that matches nothing is rejected — persisting the mask
// literal as the token would silently break the channel.
function restoreTokens(next: ElevenConfig, current: ElevenConfig): void {
  for (const [name, workspace] of Object.entries(next.workspaces)) {
    const existing = current.workspaces[name]?.channels ?? [];
    (workspace.channels ?? []).forEach((channel, index) => {
      if (channel.token !== SECRET_MASK) return;
      const stored = existing.find((c) => c.name === channel.name) ?? existing[index];
      if (!stored) throw new Error(`channel "${channel.name}" has a masked token with no stored value — enter the real token`);
      channel.token = stored.token;
    });
  }
}

function fail(res: ServerResponse, status: number, error: unknown) {
  log.error(String(error));
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(JSON.stringify({ error: String(error) }));
}

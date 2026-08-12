import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { BUILTIN_TOOLS, CHANNEL_TYPES, DEFAULT_REASONING, isUnresolved, REASONING_LEVELS, runtimeTools, type ConfigStore, type ElevenConfig } from "../config.ts";
import { collectProviderUsage } from "../provider-usage.ts";
import { parseTelegramSessionKey } from "../channels/telegram/session-key.ts";
import { BUILTIN_SYSTEM_PROMPT } from "../agent/system-prompt.ts";
import { listWorkspaceSkills } from "../agent/runner.ts";
import type { Gateway } from "../gateway.ts";
import type { TelegramChannel } from "../channels/telegram/index.ts";
import { readThreadTimeline, readToolResult } from "../threads/reader.ts";
import { findModel, modelRuntime } from "../agent/pi.ts";
import { logger } from "../log.ts";

const log = logger("dashboard");
const PUBLIC_DIR = join(import.meta.dirname, "public");
// One Telegram rich-message request: avoids ambiguous partial delivery and
// duplicate prefixes when a multi-chunk send fails midway.
const MAX_OUTBOUND_MESSAGE_CHARS = 32_000;
// How much of a message the activity broadcast carries. Enough to read the
// bubble; the transcript refetch that follows replaces it with the real thing.
const ACTIVITY_PREVIEW_CHARS = 4_000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

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
  gateway.on("turn-start", (event) => broadcast({ type: "turn-start", ...event }));
  gateway.on("turn-done", (event) => broadcast({ type: "turn-done", ...event }));
  gateway.on("turn-error", (event) => broadcast({ type: "turn-error", ...event }));
  gateway.on("turn-rewound", (event) => broadcast({ type: "turn-rewound", ...event }));
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

  function conversationLabel(sessionKey: string): string {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target) {
      const source = sessionKey.split(":", 1)[0];
      return source === "dashboard" ? "Dashboard" : source === "cli" ? "CLI" : source;
    }
    const route = config.channels().find(({ channel }) => channel.name === target.channel);
    const chatKey = String(target.chatId);
    if (target.chatId > 0) {
      const user = route?.channel.users?.[chatKey];
      const identity = user?.name || (user?.username ? `@${user.username}` : chatKey);
      return `Telegram DM · ${identity}`;
    }
    const group = route?.channel.groups?.[chatKey];
    const groupName = group?.title || chatKey;
    const topic = target.topic !== undefined ? group?.topics?.[String(target.topic)]?.title || `topic ${target.topic}` : undefined;
    return `Telegram · ${groupName}${topic ? ` · ${topic}` : ""}`;
  }

  /** The group/topic model scopes a Telegram conversation would run with. */
  function channelModelScopes(sessionKey: string) {
    const target = parseTelegramSessionKey(sessionKey);
    if (!target) return [];
    const group = config.channels().find(({ channel }) => channel.name === target.channel)?.channel.groups?.[String(target.chatId)];
    const topic = target.topic !== undefined ? group?.topics?.[String(target.topic)] : undefined;
    return [topic, group];
  }

  function threadView(thread: ReturnType<typeof gateway.threads.list>[number]) {
    const current = gateway.threads.isCurrent(thread.id);
    const running = gateway.isThreadRunning(thread.id);
    return {
      ...thread,
      current,
      running,
      state: running ? "running" : current ? "current" : "old",
      source: thread.sessionKey.split(":", 1)[0],
      conversation: conversationLabel(thread.sessionKey),
    };
  }

  function listThreadViews(url: URL) {
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
    let threads = gateway.threads.list(workspace).map(threadView);
    if (channel) threads = threads.filter((thread) => thread.source === channel);
    if (currentOnly) threads = threads.filter((thread) => thread.current);
    if (runningOnly) threads = threads.filter((thread) => thread.running);
    if (since !== undefined) threads = threads.filter((thread) => thread.lastActivityAt >= since);
    return limit ? threads.slice(0, limit) : threads;
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

    const file = path === "/" ? "/index.html" : path;
    // Resolve then confine to PUBLIC_DIR. `replaceAll("..","")` was a fragile
    // denylist that also mangled legitimate names containing "..".
    const target = normalize(join(PUBLIC_DIR, file));
    try {
      if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) throw new Error("path escapes public dir");
      const content = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        // Fonts never change — cache them hard. The app shell (html/js/css)
        // changes with the daemon, so that always revalidates.
        "cache-control": file.startsWith("/fonts/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(content);
    } catch {
      // SPA fallback: unknown paths render the app shell.
      const content = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(content);
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.slice(4);
    const method = req.method ?? "GET";
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
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
          workspaces: redactTokens(config.resolved).workspaces,
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
        return send(200, listThreadViews(url));
      }
      if (method === "GET" && path.match(/^\/threads\/[^/]+\/run$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const run = cliRuns.get(thread.id);
        if (!run) throw new ApiError(404, "no CLI run is tracked for this thread");
        return send(200, run);
      }
      if (method === "GET" && path.match(/^\/threads\/[^/]+$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const [timeline, requests] = await Promise.all([
          thread.sessionFile ? readThreadTimeline(thread.sessionFile) : [],
          gateway.requests.list(thread.id),
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
            ...threadView(thread),
            effectiveModel,
            lastModel: requests.at(-1)?.model,
            messages: messages.length,
            turns: messages.filter((message) => message.role === "user").length,
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
        const request = (await body(req)) as { workspace: string; text: string; source?: string };
        const { workspace, text } = request;
        if (!config.resolved.workspaces[workspace]) throw new Error(`workspace ${workspace} not found`);
        if (!text?.trim()) throw new Error("message is required");
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
          void runLocalTurn(sessionKey, text, source).then(
            (result) => cliRuns.set(thread.id, { status: "done", result }),
            (error) => cliRuns.set(thread.id, { status: "error", error: error instanceof Error ? error.message : String(error) }),
          );
          return send(201, threadView(thread));
        }
        void runLocalTurn(sessionKey, text, source).catch(() => {});
        return send(201, thread);
      }
      if (method === "POST" && path.match(/^\/threads\/[^/]+\/message$/)) {
        const thread = resolveThreadRef(path.split("/")[2]);
        const { text } = (await body(req)) as { text: string };
        void runLocalTurn(thread.sessionKey, text, "dashboard").catch(() => {});
        return send(202, { ok: true });
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

  async function runLocalTurn(sessionKey: string, message: string, source: "dashboard" | "cli") {
    // turn-done/turn-error reach the UI via the gateway's own events.
    try {
      return await gateway.handle({
        sessionKey,
        text: message,
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

const MAX_API_BODY_BYTES = 1024 * 1024;

async function body(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) throw new ApiError(413, "request body too large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_API_BODY_BYTES) throw new ApiError(413, "request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
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

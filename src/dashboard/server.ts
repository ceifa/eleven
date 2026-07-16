import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { join, extname, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { BUILTIN_TOOLS, CHANNEL_TYPES, isUnresolved, type ConfigStore, type ElevenConfig } from "../config.ts";
import { BUILTIN_SYSTEM_PROMPT } from "../agent/system-prompt.ts";
import type { Gateway } from "../gateway.ts";
import type { TelegramChannel } from "../channels/telegram/index.ts";
import { readThreadMessages } from "../threads/reader.ts";
import { modelRegistry } from "../agent/pi.ts";
import { logger } from "../log.ts";

const log = logger("dashboard");
const PUBLIC_DIR = join(import.meta.dirname, "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface Dashboard {
  close(): Promise<void>;
}

export function startDashboard(config: ConfigStore, gateway: Gateway, telegram: TelegramChannel): Dashboard {
  const server = createServer((req, res) => void route(req, res).catch((error) => fail(res, 500, error)));
  const wss = new WebSocketServer({ server, path: "/ws" });

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
  gateway.on("turn-done", (event) => broadcast({ type: "turn-done", ...event }));
  gateway.on("turn-error", (event) => broadcast({ type: "turn-error", ...event }));
  gateway.on("thread-activity", ({ thread, direction }) =>
    broadcast({ type: "activity", threadId: thread.id, workspace: thread.workspace, direction }),
  );
  telegram.pairing.on("request", (request) => broadcast({ type: "pairing", request }));
  // The daemon itself mutates config (pairing approvals, group/topic auto-registry) —
  // let open dashboards refresh instead of showing stale state.
  config.on("change", () => broadcast({ type: "config-changed" }));

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
      if (method === "GET" && path === "/overview") {
        return send(200, {
          bots: telegram.status(),
          pairing: telegram.pairing.list(),
          workspaces: redactTokens(config.resolved).workspaces,
          providers: config.resolved.providers,
          tools: BUILTIN_TOOLS,
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
        const workspace = url.searchParams.get("workspace") ?? undefined;
        return send(200, gateway.threads.list(workspace));
      }
      if (method === "GET" && path.match(/^\/threads\/[^/]+$/)) {
        const thread = gateway.threads.get(path.split("/")[2]);
        if (!thread) return send(404, { error: "thread not found" });
        const [messages, requests] = await Promise.all([
          thread.sessionFile ? readThreadMessages(thread.sessionFile) : [],
          gateway.requests.list(thread.id),
        ]);
        return send(200, { thread, messages, requests });
      }
      if (method === "GET" && path.match(/^\/requests\/[^/]+\/[^/]+$/)) {
        const [, , threadId, requestId] = path.split("/");
        const entry = await gateway.requests.get(threadId, requestId);
        if (!entry) return send(404, { error: "request not found" });
        return send(200, entry);
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
        const { workspace, text } = (await body(req)) as { workspace: string; text: string };
        const sessionKey = `dashboard:${workspace}:${randomUUID()}`;
        const thread = gateway.newThread(sessionKey, workspace);
        void runDashboardTurn(sessionKey, text);
        return send(201, thread);
      }
      if (method === "POST" && path.match(/^\/threads\/[^/]+\/message$/)) {
        const thread = gateway.threads.get(path.split("/")[2]);
        if (!thread) return send(404, { error: "thread not found" });
        const { text } = (await body(req)) as { text: string };
        void runDashboardTurn(thread.sessionKey, text);
        return send(202, { ok: true });
      }
      if (method === "POST" && path.match(/^\/pairing\/[^/]+\/(approve|deny)$/)) {
        const [, , requestId, action] = path.split("/");
        const request = action === "approve" ? await telegram.approvePairing(requestId) : telegram.denyPairing(requestId);
        return send(200, request);
      }
      if (method === "GET" && path === "/models") {
        return send(200, modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort());
      }
      if (method === "GET" && path === "/providers") {
        const configured = new Set(
          [config.resolved.providers.defaultModel, ...config.resolved.providers.fallbackModels]
            .map((ref) => ref.split("/")[0])
            .filter(Boolean),
        );
        for (const model of modelRegistry.getAvailable()) configured.add(model.provider);
        return send(
          200,
          [...configured].sort().map((provider) => ({ provider, ...authStatus(provider) })),
        );
      }
      return send(404, { error: "not found" });
    } catch (error) {
      log.warn(`api ${method} ${path}: ${error}`);
      return send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function runDashboardTurn(sessionKey: string, message: string) {
    // turn-done/turn-error reach the UI via the gateway's own events.
    await gateway
      .handle({
        sessionKey,
        text: message,
        runtime: { channel: "dashboard", conversation: "eleven web dashboard", capabilities: ["rich markdown"] },
        workspaceHint: gateway.threads.current(sessionKey)?.workspace,
      })
      .catch((error) => log.warn(`dashboard turn failed: ${error}`));
  }

  function authStatus(provider: string) {
    try {
      const status = modelRegistry.getProviderAuthStatus(provider);
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

async function body(req: IncomingMessage): Promise<unknown> {
  const raw = await text(req);
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

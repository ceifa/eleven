import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConfigStore } from "../config.ts";
import type { Gateway } from "../gateway.ts";
import type { Channels } from "../channels/index.ts";
import { logger } from "../log.ts";
import { createApi } from "./api.ts";
import { serveStatic, warmShell } from "./assets.ts";
import { startLiveFeed } from "./broadcast.ts";
import { createContext } from "./context.ts";
import { fail } from "./http.ts";

const log = logger("dashboard");

export interface Dashboard {
  close(): Promise<void>;
}

/**
 * The dashboard: one HTTP server answering the API under `/api` (api.ts, with
 * the handlers in routes/), the app shell and its files everywhere else
 * (assets.ts), and the websocket at `/ws` that keeps open pages live
 * (broadcast.ts).
 */
export function startDashboard(config: ConfigStore, gateway: Gateway, channels: Channels): Dashboard {
  const server = createServer((req, res) => void route(req, res).catch((error) => fail(res, 500, error)));
  const feed = startLiveFeed(server, config, gateway, channels);
  const api = createApi(createContext(config, gateway, channels, feed.broadcast));

  async function route(req: IncomingMessage, res: ServerResponse) {
    // A request target that is not a path (`//`) is nothing either half can answer.
    if (!URL.canParse(req.url ?? "/", "http://localhost")) return void res.writeHead(400).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/api" || path.startsWith("/api/")) return api(req, res, url);

    // The shell and its files are only ever read. Answering a POST with the
    // page would tell whoever sent it that it had been taken.
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    return serveStatic(req, res, path);
  }

  const { host, port } = config.resolved.dashboard;
  warmShell();
  server.listen(port, host, () => log.info(`dashboard on http://${host}:${port}`));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        feed.close();
        server.close(() => resolve());
      }),
  };
}

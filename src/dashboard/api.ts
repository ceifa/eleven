import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../log.ts";
import type { DashboardContext } from "./context.ts";
import { crossOrigin, deliver, errorStatus, sendJson } from "./http.ts";
import { createRouter } from "./router.ts";
import { channelRoutes } from "./routes/channels.ts";
import { configRoutes } from "./routes/config.ts";
import { mediaRoutes } from "./routes/media.ts";
import { modelRoutes } from "./routes/models.ts";
import { threadRoutes } from "./routes/threads.ts";
import { turnRoutes } from "./routes/turns.ts";

const log = logger("dashboard");

/** Everything under `/api`: the guards every request passes, the route table,
 *  and the one place a handler's error becomes a response. */
export function createApi(context: DashboardContext) {
  // The first match wins — and no two of these can match the same request, so
  // the order the groups are listed in decides nothing.
  const match = createRouter([
    ...configRoutes(context),
    ...threadRoutes(context),
    ...turnRoutes(context),
    ...mediaRoutes(context),
    ...channelRoutes(context),
    ...modelRoutes(context),
  ]);

  return async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.slice(4);
    const method = req.method ?? "GET";
    const send = (status: number, payload: unknown) => sendJson(req, res, status, payload);

    // CSRF guard: state-changing requests must be same-origin. A hostile page
    // can fire a no-preflight cross-origin POST at 127.0.0.1 (or the tunnel) and
    // drive the bash/edit/write-capable agent; browsers always attach Origin to
    // such requests, so a mismatch with Host is the tell. Non-browser clients
    // (curl, the agent itself) send no Origin and are unaffected.
    if (method !== "GET" && method !== "HEAD" && crossOrigin(req)) {
      return send(403, { error: "cross-origin request refused" });
    }

    // The dashboard's way back through an auth proxy whose session ran out
    // (see signIn in public/api.js): the proxy sends this navigation to its sign-in and
    // back here, and here sends it on to the app.
    if (method === "GET" && path === "/signin") {
      res.writeHead(303, { location: "/" });
      return res.end();
    }

    // An answer a handler started is still being written (compressed, usually)
    // when the handler returns. It is kept here rather than awaited inside the
    // try below: what goes wrong while working an answer out becomes a JSON
    // error, what goes wrong while writing one is the server's 500.
    let written: unknown;
    try {
      const found = match(method, path);
      if (!found) return send(404, { error: "not found" });
      await found.route.handler({
        req,
        res,
        url,
        params: found.params,
        send: (status, payload) => void (written = send(status, payload)),
        deliver: (status, headers, body) => void (written = deliver(req, res, status, headers, body)),
      });
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) log.error(`api ${method} ${path}: ${error instanceof Error ? error.stack ?? error : error}`);
      else log.warn(`api ${method} ${path}: ${error}`);
      return send(status, { error: error instanceof Error ? error.message : String(error) });
    }
    return written;
  };
}

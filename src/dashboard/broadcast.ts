import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ConfigStore } from "../config.ts";
import type { Gateway } from "../gateway.ts";
import type { Channels } from "../channels/index.ts";
import { logger } from "../log.ts";
import { shellVersion } from "./assets.ts";

const log = logger("dashboard");
// How much of a message the activity broadcast carries. Enough to read the
// bubble; the transcript refetch that follows replaces it with the real thing.
const ACTIVITY_PREVIEW_CHARS = 4_000;

export type Broadcast = (payload: { type: string; threadId?: string; delta?: string } & Record<string, unknown>) => void;

export interface LiveFeed {
  /** Push one event to every open dashboard. */
  broadcast: Broadcast;
  /** Stop the timers and drop every socket. Synchronous: the HTTP server the
   *  sockets ride on is closed by whoever owns it. */
  close(): void;
}

/**
 * The websocket half of the dashboard: `/ws` on the given HTTP server, and
 * everything the daemon announces on it — the gateway's turn events, pairing
 * requests, config changes.
 */
export function startLiveFeed(server: Server, config: ConfigStore, gateway: Gateway, channels: Channels): LiveFeed {
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

  const broadcast: Broadcast = (payload) => {
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
    socket.send(JSON.stringify({ type: "hello", shell: shellVersion() }));
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
  gateway.on("panels", (event) => broadcast({ type: "panels", ...event }));
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
  channels.pairing.on("request", (request) => broadcast({ type: "pairing", request }));
  // The daemon itself mutates config (pairing approvals, group/topic auto-registry) —
  // let open dashboards refresh instead of showing stale state.
  config.on("change", () => broadcast({ type: "config-changed" }));

  return {
    broadcast,
    close() {
      clearInterval(heartbeat);
      clearTimeout(deltaTimer);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

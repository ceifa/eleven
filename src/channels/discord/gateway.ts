import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayOpcodes,
  type GatewayDispatchPayload,
  type GatewayReadyDispatchData,
  type GatewayReceivePayload,
  type GatewaySendPayload,
} from "discord-api-types/v10";
import type { logger } from "../../log.ts";

const GATEWAY_URL = "wss://gateway.discord.gg";
const QUERY = "/?v=10&encoding=json";
const RECONNECT_MAX_MS = 60_000;
// Discord says to wait a random 1–5 s before identifying again after an
// invalid session.
const INVALID_SESSION_MIN_MS = 1_000;
const INVALID_SESSION_JITTER_MS = 4_000;
// ws's 100 MiB default would let one payload eat the heap before it is parsed;
// Discord's largest (member chunks, which we never ask for) stay far below this.
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// A handshake that never answers must still end, so the reconnect loop runs.
const HANDSHAKE_TIMEOUT_MS = 30_000;
// Any close but 1000/1001 keeps the session resumable on Discord's side.
const RESUMABLE_CLOSE = 4000;

/** No retry fixes these: the token, the intents or the API version are wrong. */
const FATAL_CLOSES = new Set<number>([
  GatewayCloseCodes.AuthenticationFailed,
  GatewayCloseCodes.InvalidShard,
  GatewayCloseCodes.ShardingRequired,
  GatewayCloseCodes.InvalidAPIVersion,
  GatewayCloseCodes.InvalidIntents,
  GatewayCloseCodes.DisallowedIntents,
]);

/** These end the session: reconnect, but identify from scratch. */
const SESSION_ENDING_CLOSES = new Set<number>([
  GatewayCloseCodes.NotAuthenticated,
  GatewayCloseCodes.InvalidSeq,
  GatewayCloseCodes.SessionTimedOut,
  GatewayCloseCodes.AlreadyAuthenticated,
]);

/**
 * One bot's connection to Discord's gateway: hello, heartbeat, identify, and
 * resume across every drop it can survive — a zombie connection (a heartbeat
 * nobody acknowledged), a server-asked reconnect, an invalidated session.
 * Resuming replays what was missed, so a drop costs no messages. Emits
 * `dispatch` for every event and `fatal` when no reconnect can help.
 */
export class DiscordGateway extends EventEmitter<{
  dispatch: [GatewayDispatchPayload];
  ready: [GatewayReadyDispatchData];
  fatal: [number];
}> {
  /** READY or RESUMED arrived on the open socket. */
  ready = false;
  /** When Discord last acknowledged a heartbeat. */
  lastAckAt = 0;
  private ws: WebSocket | undefined;
  private seq: number | null = null;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private acked = true;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempts = 0;
  private stopped = false;
  private token: string;
  private intents: number;
  private log: ReturnType<typeof logger>;
  private createSocket: (url: string) => WebSocket;

  constructor(
    token: string,
    intents: number,
    log: ReturnType<typeof logger>,
    createSocket = (url: string) => new WebSocket(url, { maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: HANDSHAKE_TIMEOUT_MS }),
  ) {
    super();
    this.token = token;
    this.intents = intents;
    this.log = log;
    this.createSocket = createSocket;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ready = false;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
  }

  private open(): void {
    const resuming = this.resumable;
    const ws = this.createSocket(`${(resuming && this.resumeUrl) || GATEWAY_URL}${QUERY}`);
    this.ws = ws;
    // Events of a socket we already gave up on must not touch the new one.
    ws.on("message", (data) => {
      if (ws !== this.ws) return;
      let payload: GatewayReceivePayload;
      try {
        payload = JSON.parse(String(data));
      } catch {
        this.log.warn("gateway sent a payload that is not JSON");
        return;
      }
      this.receive(payload, resuming);
    });
    ws.on("close", (code, reason) => {
      if (ws !== this.ws) return;
      this.closed(code, String(reason));
    });
    ws.on("error", (error) => this.log.warn(`gateway socket error: ${error.message}`));
  }

  private receive(payload: GatewayReceivePayload, resuming: boolean): void {
    if (payload.op === GatewayOpcodes.Dispatch && payload.s !== null) this.seq = payload.s;
    switch (payload.op) {
      case GatewayOpcodes.Hello: {
        this.startHeartbeat(payload.d.heartbeat_interval);
        if (resuming && this.resumable) {
          this.send({ op: GatewayOpcodes.Resume, d: { token: this.token, session_id: this.sessionId!, seq: this.seq! } });
        } else {
          this.send({
            op: GatewayOpcodes.Identify,
            d: { token: this.token, intents: this.intents, properties: { os: process.platform, browser: "eleven", device: "eleven" } },
          });
        }
        return;
      }
      case GatewayOpcodes.HeartbeatAck:
        this.acked = true;
        this.lastAckAt = Date.now();
        return;
      case GatewayOpcodes.Heartbeat:
        this.beat();
        return;
      case GatewayOpcodes.Reconnect:
        this.log.info("gateway asked to reconnect");
        this.reconnect(true);
        return;
      case GatewayOpcodes.InvalidSession:
        // `d` says whether the session can still be resumed.
        this.log.info(`gateway invalidated the session (resumable: ${payload.d})`);
        this.reconnect(payload.d, INVALID_SESSION_MIN_MS + Math.random() * INVALID_SESSION_JITTER_MS);
        return;
      case GatewayOpcodes.Dispatch:
        if (payload.t === GatewayDispatchEvents.Ready) {
          this.sessionId = payload.d.session_id;
          this.resumeUrl = payload.d.resume_gateway_url;
          this.markReady();
          this.emit("ready", payload.d);
        } else if (payload.t === GatewayDispatchEvents.Resumed) {
          this.markReady();
        }
        this.emit("dispatch", payload);
        return;
    }
  }

  private markReady(): void {
    this.ready = true;
    this.attempts = 0;
    this.lastAckAt = Date.now();
  }

  private get resumable(): boolean {
    return this.sessionId !== undefined && this.seq !== null;
  }

  private closed(code: number, reason: string): void {
    this.ws = undefined;
    this.stopHeartbeat();
    this.ready = false;
    if (this.stopped) return;
    if (FATAL_CLOSES.has(code)) {
      this.log.error(`gateway closed for good (${code}${reason ? `: ${reason}` : ""})`);
      this.emit("fatal", code);
      return;
    }
    this.log.warn(`gateway closed (${code}${reason ? `: ${reason}` : ""}), reconnecting`);
    if (SESSION_ENDING_CLOSES.has(code)) this.forget();
    this.schedule();
  }

  /** Drop the socket on purpose and come back — resuming the session, or
   *  starting a fresh one. */
  private reconnect(resume: boolean, minDelayMs = 0): void {
    const ws = this.ws;
    this.ws = undefined;
    this.stopHeartbeat();
    this.ready = false;
    if (!resume) this.forget();
    ws?.close(RESUMABLE_CLOSE);
    if (!this.stopped) this.schedule(minDelayMs);
  }

  private forget(): void {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
  }

  private schedule(minDelayMs = 0): void {
    clearTimeout(this.reconnectTimer);
    const backoff = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** Math.min(this.attempts, 6));
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.open(), Math.max(minDelayMs, backoff * (0.8 + Math.random() * 0.4)));
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.acked = true;
    const tick = () => {
      // The last beat went unanswered: the connection is a zombie that still
      // looks open. Only a fresh socket tells.
      if (!this.acked) {
        this.log.warn("gateway heartbeat went unacknowledged, reconnecting");
        this.reconnect(true);
        return;
      }
      this.beat();
      this.heartbeat = setTimeout(tick, intervalMs);
    };
    // The first beat waits a random slice of the interval, as Discord asks, so
    // a fleet of reconnecting clients doesn't beat in lockstep.
    this.heartbeat = setTimeout(tick, intervalMs * Math.random());
  }

  private stopHeartbeat(): void {
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
  }

  private beat(): void {
    this.acked = false;
    this.send({ op: GatewayOpcodes.Heartbeat, d: this.seq });
  }

  private send(payload: GatewaySendPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

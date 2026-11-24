import { createServer, request, type Server } from "node:http";
import { chmodSync, rmSync } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { logger } from "./log.ts";
import { STATE_DIR } from "./paths.ts";

const log = logger("secrets");

/**
 * Secrets a person hands the agent for one job: held in the daemon's memory
 * only, gone when the time runs out or the daemon stops. Nothing writes them
 * to disk, to a transcript or to the chat — the agent learns a name, and a
 * command it runs gets the value through its environment.
 */

export const SECRETS_SOCKET = join(STATE_DIR, "secrets.sock");
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const DEFAULT_SECRET_MINUTES = 30;
export const MAX_SECRET_MINUTES = 24 * 60;

export interface SecretInfo {
  name: string;
  expiresAt: number;
}

export class EphemeralSecrets {
  private entries = new Map<string, { value: string; expiresAt: number; timer: NodeJS.Timeout }>();

  put(name: string, value: string, minutes: number, now = Date.now()): SecretInfo {
    if (!SECRET_NAME.test(name)) throw new Error(`invalid secret name: ${name}`);
    this.delete(name);
    const ms = clampMinutes(minutes) * 60_000;
    const timer = setTimeout(() => this.entries.delete(name), ms);
    timer.unref();
    const expiresAt = now + ms;
    this.entries.set(name, { value, expiresAt, timer });
    return { name, expiresAt };
  }

  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }

  delete(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    clearTimeout(entry.timer);
    return this.entries.delete(name);
  }

  list(): SecretInfo[] {
    return [...this.entries].map(([name, { expiresAt }]) => ({ name, expiresAt }));
  }
}

export function clampMinutes(minutes: number | undefined): number {
  if (!Number.isFinite(minutes) || !minutes || minutes < 1) return DEFAULT_SECRET_MINUTES;
  return Math.min(Math.floor(minutes), MAX_SECRET_MINUTES);
}

/** The daemon's one store. */
export const secrets = new EphemeralSecrets();

/**
 * A unix socket, readable by the owner only. Deliberately not a dashboard
 * route: the dashboard can sit behind a tunnel, and a value must never be one
 * request away from the internet.
 */
export function serveSecrets(store: EphemeralSecrets, socketPath = SECRETS_SOCKET): Server {
  rmSync(socketPath, { force: true });
  const server = createServer((req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    const name = decodeURIComponent(req.url?.match(/^\/secrets\/([^/?]+)$/)?.[1] ?? "");
    if (req.method === "GET" && req.url === "/secrets") return send(200, store.list());
    if (name && req.method === "GET") {
      const value = store.get(name);
      return value === undefined ? send(404, { error: `no secret named ${name} (expired or never sent)` }) : send(200, { name, value });
    }
    if (name && req.method === "DELETE") return send(200, { deleted: store.delete(name) });
    send(404, { error: "not found" });
  });
  server.on("error", (error) => log.error(`secret socket: ${error.message}`));
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  server.unref();
  return server;
}

export async function secretsRequest<T>(method: string, path: string, socketPath = SECRETS_SOCKET): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: 5_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if ((res.statusCode ?? 500) >= 400) reject(new Error(payload.error ?? `HTTP ${res.statusCode}`));
        else resolve(payload);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error) => reject(new Error(`cannot reach eleven's secret socket: ${error.message}`)));
    req.end();
  });
}

/**
 * Replaces every occurrence of the values with `[NAME]`, also when one is
 * split across chunks: the tail that could still be the start of a value is
 * held until the next chunk (or the end) settles it.
 */
export class SecretMask extends Transform {
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private readonly hold: number;
  private readonly values: { name: string; value: string }[];

  constructor(values: { name: string; value: string }[]) {
    super();
    this.values = values.filter((entry) => entry.value).sort((a, b) => b.value.length - a.value.length);
    this.hold = Math.max(0, ...this.values.map((entry) => entry.value.length - 1));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    const text = this.mask(this.pending + this.decoder.write(chunk));
    const cut = Math.max(0, text.length - this.hold);
    this.pending = text.slice(cut);
    done(null, text.slice(0, cut));
  }

  override _flush(done: TransformCallback) {
    done(null, this.mask(this.pending + this.decoder.end()));
  }

  private mask(text: string): string {
    for (const { name, value } of this.values) text = text.split(value).join(`[${name}]`);
    return text;
  }
}

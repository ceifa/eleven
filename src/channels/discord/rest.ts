import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename } from "node:path";
import { Agent, FormData, fetch as undiciFetch, type RequestInit, type Response } from "undici";
import { logger } from "../../log.ts";
import { failedBeforeConnecting } from "../network.ts";

const log = logger("discord/rest");

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ceifa/eleven, 1)";
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const RETRY_AFTER_CAP_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// An acknowledgment that reached Discord in time can still answer late on a
// slow link, and whether it landed decides where the command's answer goes.
const INTERACTION_TIMEOUT_MS = 6_000;
const INTERACTION_HEDGE_MS = 1_000;

/** Discord's error codes for "already in the state you wanted". */
const NOOP_CODES = new Set([
  10008, // Unknown Message — deleting what is already gone
  10014, // Unknown Emoji
  50083, // the thread is archived — a status edit after it closed
]);

export class DiscordApiError extends Error {
  status: number;
  code?: number;
  constructor(status: number, body: { message?: string; code?: number; errors?: unknown } | undefined) {
    const detail = body?.errors ? ` ${JSON.stringify(body.errors)}` : "";
    super(`Discord API ${status}${body?.code ? ` (${body.code})` : ""}: ${body?.message ?? "request failed"}${detail}`);
    this.status = status;
    this.code = body?.code;
  }
}

export class DiscordSendUncertain extends Error {}

export const canRetrySend = (error: unknown) => !(error instanceof DiscordSendUncertain) &&
  (failedBeforeConnecting(error) || error instanceof DiscordApiError && error.status === 429);

export function isNoop(error: unknown): boolean {
  return error instanceof DiscordApiError && error.code !== undefined && NOOP_CODES.has(error.code);
}

/** A local file to upload with a message. */
export interface Upload {
  path: string;
  name?: string;
}

export interface RequestOptions {
  body?: unknown;
  files?: Upload[];
  /** A creation without Discord nonce support cannot be retried once it may
   *  have reached Discord. */
  creates?: boolean;
}

/**
 * Discord's REST API over fetch. A 429 is always safe to retry — Discord
 * refused the request — so it waits out `retry_after` and goes again; a 5xx
 * or a network failure is retried only when repeating the call cannot
 * duplicate what it did. Channel messages reuse a Discord-enforced nonce.
 */
export class DiscordRest {
  private token: string;
  private fetch: typeof undiciFetch;
  private dispatcher = new Agent();

  constructor(token: string, fetchImpl: typeof undiciFetch = undiciFetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const message = method === "POST" && /^\/channels\/\d+\/messages$/.test(path);
    if (message) options = { ...options, body: { ...options.body as object, nonce: randomBytes(12).toString("hex"), enforce_nonce: true } };
    const repeatable = message || !options.creates;
    let uncertain = false;
    const terminal = (error: unknown) => uncertain ? new DiscordSendUncertain(String(error), { cause: error }) : error;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      let body: Record<string, unknown> | undefined;
      const dispatcher = this.dispatcher;
      try {
        ({ response, body } = await this.exchange(method, path, options, dispatcher, AbortSignal.timeout(REQUEST_TIMEOUT_MS)));
      } catch (error) {
        this.drop(dispatcher);
        if (message && !failedBeforeConnecting(error)) uncertain = true;
        if (attempt >= MAX_ATTEMPTS || !(repeatable || failedBeforeConnecting(error))) throw terminal(error);
        await this.wait(path, attempt, undefined, error);
        continue;
      }
      if (response.ok) return body as T;
      if (message && response.status >= 500) uncertain = true;
      const retryAfter = response.status === 429 ? retryAfterMs(response, body) : undefined;
      const retriable = retryAfter !== undefined || (response.status >= 500 && repeatable);
      if (!retriable || attempt >= MAX_ATTEMPTS) throw terminal(new DiscordApiError(response.status, body));
      await this.wait(path, attempt, retryAfter, `HTTP ${response.status}`);
    }
  }

  /** Discord takes an answer only within three seconds of the event, so a stalled acknowledgment is raced, not aborted. */
  async acknowledge(interactionId: string, token: string, body: unknown): Promise<void> {
    const path = `/interactions/${interactionId}/${token}/callback`;
    const done = new AbortController();
    const signal = AbortSignal.any([done.signal, AbortSignal.timeout(INTERACTION_TIMEOUT_MS)]);
    const shared = this.dispatcher;
    let spare: Agent | undefined;
    let winner: Agent | undefined;
    const send = async (dispatcher: Agent, hedge: boolean) => {
      const { response, body: answer } = await this.exchange("POST", path, { body }, dispatcher, signal);
      // On the hedge, "already acknowledged" means the first attempt landed.
      if (!response.ok && !(hedge && answer?.code === 40060)) throw new DiscordApiError(response.status, answer);
      winner ??= dispatcher;
    };
    const first = send(shared, false);
    const second = new Promise<void>((resolve, reject) => {
      let started = false;
      const race = (cause: unknown) => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        if (cause instanceof DiscordApiError && cause.status < 500) return reject(cause);
        log.warn(`${redact(path)} ${cause ? `failed: ${detail(cause)}` : "is slow"}, racing it on a fresh connection`);
        spare = new Agent();
        send(spare, true).then(resolve, reject);
      };
      const timer = setTimeout(() => race(undefined), INTERACTION_HEDGE_MS);
      first.then(() => clearTimeout(timer), (error) => {
        if (!(error instanceof DiscordApiError) && !done.signal.aborted) this.drop(shared);
        race(error);
      });
    });
    try {
      await Promise.any([first, second]);
    } catch (error) {
      if (error instanceof AggregateError) throw error.errors.at(-1);
      throw error;
    } finally {
      done.abort();
      // The connection that answered is the one worth keeping.
      if (spare && !(winner === spare && this.drop(shared, spare))) void spare.destroy().catch(() => {});
    }
  }

  /** One round trip: the response, and its JSON body when there is one. */
  private async exchange(method: string, path: string, options: RequestOptions, dispatcher: Agent, signal: AbortSignal) {
    const response = await this.fetch(`${API}${path}`, {
      dispatcher,
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        "user-agent": USER_AGENT,
        ...(options.files?.length || options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: await encode(options),
      signal,
    });
    let body: Record<string, unknown> | undefined;
    if (response.status === 204) return { response, body };
    try {
      body = await response.json() as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { response, body };
  }

  /** Discord speaks HTTP/2, so every call shares one connection, and a
   *  timeout cancels only its own request: a connection that stopped
   *  answering would take every later call down with it. */
  private drop(dispatcher: Agent, next = new Agent()): boolean {
    if (dispatcher !== this.dispatcher) return false;
    this.dispatcher = next;
    void dispatcher.destroy().catch(() => {});
    return true;
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }

  private async wait(path: string, attempt: number, retryAfter: number | undefined, cause: unknown): Promise<void> {
    const ms = retryAfter ?? BASE_DELAY_MS * 2 ** (attempt - 1);
    log.warn(`${redact(path)} failed (attempt ${attempt}), retrying in ${Math.round(ms)}ms: ${detail(cause)}`);
    await delay(ms);
  }
}

const redact = (path: string) => path.replace(/^(\/interactions|\/webhooks)\/([^/]+)\/[^/]+/, "$1/$2/[redacted]");
const detail = (cause: unknown) => cause instanceof Error && cause.cause ? `${cause}: ${cause.cause}` : String(cause);

/** JSON, or multipart when files ride along: the payload in `payload_json`,
 *  each file as `files[n]` and announced in `attachments`. */
async function encode(options: RequestOptions): Promise<RequestInit["body"]> {
  if (!options.files?.length) return options.body === undefined ? undefined : JSON.stringify(options.body);
  const form = new FormData();
  const names = options.files.map((file) => file.name ?? basename(file.path));
  const payload = { ...(options.body as object), attachments: names.map((filename, id) => ({ id, filename })) };
  form.set("payload_json", JSON.stringify(payload));
  for (const [index, file] of options.files.entries()) {
    form.set(`files[${index}]`, new Blob([await readFile(file.path)]), names[index]);
  }
  return form;
}

function retryAfterMs(response: Response, body: Record<string, unknown> | undefined): number {
  const seconds = typeof body?.retry_after === "number" ? body.retry_after : Number(response.headers.get("retry-after") ?? 1);
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}


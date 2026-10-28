import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename } from "node:path";
import { logger } from "../../log.ts";

const log = logger("discord/rest");

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ceifa/eleven, 1)";
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const RETRY_AFTER_CAP_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const INTERACTION_TIMEOUT_MS = 2_500;
const INTERACTION_ATTEMPT_TIMEOUT_MS = 1_000;

/** Errors that provably happened before the request reached Discord. */
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

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
  private fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const message = method === "POST" && /^\/channels\/\d+\/messages$/.test(path);
    if (message) options = { ...options, body: { ...options.body as object, nonce: randomBytes(12).toString("hex"), enforce_nonce: true } };
    const repeatable = message || !options.creates;
    const deadline = path.startsWith("/interactions/") ? AbortSignal.timeout(INTERACTION_TIMEOUT_MS) : undefined;
    for (let attempt = 1; ; attempt++) {
      deadline?.throwIfAborted();
      let response: Response;
      let body: Record<string, unknown> | undefined;
      try {
        response = await this.fetch(`${API}${path}`, {
          method,
          headers: {
            authorization: `Bot ${this.token}`,
            "user-agent": USER_AGENT,
            ...(options.files?.length || options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: await encode(options),
          signal: deadline
            ? AbortSignal.any([deadline, AbortSignal.timeout(INTERACTION_ATTEMPT_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 204) return undefined as T;
        try {
          body = await response.json() as Record<string, unknown>;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      } catch (error) {
        if (deadline?.aborted || attempt >= MAX_ATTEMPTS || !(repeatable || preConnect(error))) throw error;
        await this.wait(path, attempt, undefined, error, deadline);
        continue;
      }
      if (response.ok) return body as T;
      // Discord's "already acknowledged" confirms the previous callback landed.
      if (deadline && attempt > 1 && body?.code === 40060) return undefined as T;
      const retryAfter = response.status === 429 ? retryAfterMs(response, body) : undefined;
      const retriable = retryAfter !== undefined || (response.status >= 500 && repeatable);
      if (!retriable || attempt >= MAX_ATTEMPTS) throw new DiscordApiError(response.status, body);
      await this.wait(path, attempt, retryAfter, `HTTP ${response.status}`, deadline);
    }
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }

  private async wait(path: string, attempt: number, retryAfter: number | undefined, cause: unknown, signal?: AbortSignal): Promise<void> {
    const ms = retryAfter ?? BASE_DELAY_MS * 2 ** (attempt - 1);
    const route = path.replace(/^(\/interactions|\/webhooks)\/([^/]+)\/[^/]+/, "$1/$2/[redacted]");
    const detail = cause instanceof Error && cause.cause ? `${cause}: ${cause.cause}` : String(cause);
    log.warn(`${route} failed (attempt ${attempt}), retrying in ${Math.round(ms)}ms: ${detail}`);
    await delay(ms, undefined, { signal });
  }
}

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

function preConnect(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? ((error as Error)?.cause as { code?: string })?.code;
  return code !== undefined && PRE_CONNECT_CODES.has(code);
}

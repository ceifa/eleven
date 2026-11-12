import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { logger } from "../log.ts";

const log = logger("dashboard");

// What is worth compressing: everything the dashboard serves that is text.
// Fonts are woff2, which is brotli already — running it again costs CPU to save
// nothing.
export const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
// Below this a compressed body saves less than the headers and CPU it costs.
export const COMPRESS_MIN_BYTES = 1024;
export const gzipAsync = promisify(gzip);
export const brotliAsync = promisify(brotliCompress);
// API payloads are compressed per response, where quality 5 is the knee of the
// curve (near-gzip cost, better than gzip ratio). Static assets are compressed
// once per daemon and get the expensive setting (see assets.ts).
const DYNAMIC_BROTLI = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } };
export type Encoding = "br" | "gzip";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ---------- HTTP delivery: caching + compression ---------- */

export const etagOf = (body: Buffer) => `"${createHash("sha1").update(body).digest("base64url")}"`;

/** True when the client already holds this exact body. */
export function isFresh(req: IncomingMessage, etag: string): boolean {
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
export async function deliver(
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

/** A JSON answer from the API. */
export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown) {
  const method = req.method ?? "GET";
  const body = Buffer.from(JSON.stringify(payload) ?? "null");
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Reads get an ETag: the dashboard refetches the thread list on every
  // event that could have touched it, and most of those answers are the
  // bytes it already holds — that costs an empty 304 instead of the list.
  // `private` for the same reason as the shell's (sendAsset, assets.ts): no shared
  // cache between this daemon and the browser gets to keep a copy.
  if (method === "GET" && status === 200) {
    headers.etag = etagOf(body);
    headers["cache-control"] = "private, no-cache";
    headers.vary = "accept-encoding";
    if (isFresh(req, headers.etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  return deliver(req, res, status, headers, body);
}

/* ---------- Request bodies ---------- */

const MAX_API_BODY_BYTES = 1024 * 1024;

/** The request's JSON body: always an object, so a handler can read fields
 *  off it without first asking what it was sent. */
export async function body(req: IncomingMessage): Promise<unknown> {
  const raw = (await rawBody(req, MAX_API_BODY_BYTES)).toString("utf8");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "request body must be a JSON object");
  return parsed;
}

/**
 * The status a handler's error answers with. A handler refuses a request by
 * throwing — an `ApiError` when the status matters, a plain `Error` otherwise —
 * and that is the request's fault. What the runtime throws on its own is not:
 * a failing disk or a bug in the daemon is a 500, and saying 400 for it tells
 * the caller to fix a request there was nothing wrong with.
 */
export function errorStatus(error: unknown): number {
  if (error instanceof ApiError) return error.status;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) return 500;
  // A system call that failed (ENOENT, EACCES, EIO, ECONNREFUSED…).
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === "string") return 500;
  return 400;
}

/** Read a request body, refusing anything over `limit` — as early as the
 *  declared length allows, and again as the bytes actually arrive. */
export async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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
export function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // malformed Origin → refuse
  }
}

export function fail(res: ServerResponse, status: number, error: unknown) {
  log.error(String(error));
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(JSON.stringify({ error: String(error) }));
}

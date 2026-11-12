import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { constants as zlibConstants } from "node:zlib";
import { brotliAsync, COMPRESSIBLE, COMPRESS_MIN_BYTES, deliver, etagOf, fail, gzipAsync, isFresh, type Encoding } from "./http.ts";
import { SHELL_FILES } from "./shell-files.ts";

const PUBLIC_DIR = join(import.meta.dirname, "public");
// Newest mtime among the app-shell files. Read per connection rather than
// once: running from a checkout, the files change under the daemon, and a
// handful of stats when a socket opens is nothing next to announcing a shell
// version that no longer matches the bytes being served.
export const shellVersion = () =>
  Math.max(
    ...SHELL_FILES.map((name) => {
      try {
        return statSync(join(PUBLIC_DIR, name)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
  // Not application/json: a manifest served as anything else is ignored, and
  // the install prompt then never appears with no error to explain why.
  ".webmanifest": "application/manifest+json",
};
// Static assets are compressed once per daemon, so they get the expensive
// setting (API payloads, compressed per response, get a cheaper one: http.ts).
const STATIC_BROTLI = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } };
// The app shell is html/js/css and hundreds of kilobytes of it; over a tunnel
// that is the whole difference between a snappy dashboard and a sluggish one.
interface Asset {
  body: Buffer;
  /** Pre-compressed variants, empty for anything already compressed. */
  encoded: Map<Encoding, Buffer>;
  etag: string;
  type: string;
  immutable: boolean;
  /** mtime and size as they were just before the read, so a later request can
   *  tell a cached body from a file that has moved on. */
  stamp: string;
}

/** Everything that is not the API: a file from `public/`, or the app shell. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  // SPA fallback: unknown paths render the app shell.
  const asset = (await loadAsset(path === "/" ? "/index.html" : path)) ?? (await loadAsset("/index.html"));
  if (!asset) return fail(res, 404, new Error("public assets are missing"));
  return sendAsset(req, res, asset);
}

/** Read, hash and compress the shell while the daemon boots, so the first
 *  browser to arrive doesn't wait on brotli. */
export function warmShell() {
  for (const file of SHELL_FILES) void loadAsset(`/${file}`);
}

// Each file is read, hashed and compressed once, and every request after that
// is answered from memory: no disk read, no re-compression, and a revalidation
// costs an empty 304. The public dir *can* change under the daemon — it is the
// checkout itself when eleven runs from source — so a cached entry is only
// trusted while the file's mtime and size still match. Without that, an edit
// mid-session hands the browser a new app.js next to a live-turn.js from
// before it, and the page dies on an import of an export that no longer exists.
const assets = new Map<string, Promise<Asset | undefined>>();

async function loadAsset(file: string): Promise<Asset | undefined> {
  const cached = assets.get(file);
  if (cached) {
    const asset = await cached;
    if (asset && asset.stamp === (await stampOf(file))) return asset;
    assets.delete(file);
  }
  // Misses are not remembered: unknown paths all fall through to the app shell,
  // and caching them would let anyone grow this map without bound.
  const pending = readAsset(file).then((asset) => (asset ? asset : (assets.delete(file), undefined)));
  assets.set(file, pending);
  return pending;
}

/** Resolve then confine to PUBLIC_DIR. `replaceAll("..","")` was a fragile
 *  denylist that also mangled legitimate names containing "..". */
function resolveAsset(file: string): string | undefined {
  const target = normalize(join(PUBLIC_DIR, file));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) return undefined;
  return target;
}

async function stampOf(file: string): Promise<string | undefined> {
  const target = resolveAsset(file);
  if (!target) return undefined;
  try {
    const info = await stat(target);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
}

async function readAsset(file: string): Promise<Asset | undefined> {
  const target = resolveAsset(file);
  if (!target) return undefined;
  // Stamp before reading, never after: a write that lands between the two
  // leaves the entry looking stale and it is read again, which is the harmless
  // way round. Stamping after would pin the new mtime onto the old bytes.
  const stamp = await stampOf(file);
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return undefined;
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const encoded = new Map<Encoding, Buffer>();
  if (COMPRESSIBLE.test(type) && body.length >= COMPRESS_MIN_BYTES) {
    const [br, gz] = await Promise.all([brotliAsync(body, STATIC_BROTLI), gzipAsync(body, { level: 9 })]);
    encoded.set("br", br);
    encoded.set("gzip", gz);
  }
  return { body, encoded, etag: etagOf(body), type, immutable: file.startsWith("/fonts/"), stamp: stamp ?? "" };
}

function sendAsset(req: IncomingMessage, res: ServerResponse, asset: Asset) {
  const headers: Record<string, string> = {
    "content-type": asset.type,
    etag: asset.etag,
    // Fonts never change — cache them hard. The app shell (html/js/css) changes
    // with the daemon, so it revalidates; with an ETag that is an empty 304
    // rather than the file again.
    // And only the browser revalidates it: `no-cache` alone lets a shared cache
    // store the file too, and Cloudflare in front of the tunnel does — .css and
    // .js are on its cache-by-default list, while html is not. It kept handing
    // out a style.css from before the tab bar, a day after the change, next to
    // the current index.html that names one. `private` keeps it out of the edge.
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "private, no-cache",
  };
  if (asset.encoded.size) headers.vary = "accept-encoding";
  if (isFresh(req, asset.etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  return deliver(req, res, 200, headers, asset.body, asset.encoded);
}

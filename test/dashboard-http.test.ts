import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { startDashboard } from "../src/dashboard/server.ts";

const PUBLIC_DIR = join(import.meta.dirname, "..", "src", "dashboard", "public");

/** A port nothing else is on. The dashboard binds what the config tells it to,
 *  so the test has to pick one rather than read one back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** A raw request: fetch() transparently decodes content-encoding, which is
 *  exactly the layer under test — this keeps the body as it went over the wire. */
function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Enough of a daemon for the HTTP layer: one workspace, one thread, no bots. */
async function withDashboard(run: (base: string, thread: { id: string; sessionFile: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "eleven-dashboard-http-"));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");
  const thread = {
    id: "11111111-2222-3333-4444-555555555555",
    sessionKey: "dashboard:agent:11111111",
    workspace: "agent",
    sessionFile,
    createdAt: 1_000,
    lastActivityAt: 2_000,
    title: "a thread",
  };
  const port = await freePort();
  const config = {
    raw: { workspaces: { agent: { path: dir } }, dashboard: { host: "127.0.0.1", port } },
    resolved: { workspaces: { agent: { path: dir } }, dashboard: { host: "127.0.0.1", port }, models: [] },
    channels: () => [],
    turnModels: () => [],
    configuredModelRefs: () => [],
    on: () => {},
  };
  const gateway = {
    on: () => {},
    threads: {
      list: () => [thread],
      get: (id: string) => (id === thread.id ? thread : undefined),
      isCurrent: () => true,
      current: () => thread,
    },
    isThreadRunning: () => false,
    requests: { list: async () => [] },
    liveTurn: () => undefined,
  };
  const telegram = { status: () => [], pairing: { list: () => [], on: () => {} } };
  const dashboard = startDashboard(config as never, gateway as never, telegram as never);
  try {
    await run(`http://127.0.0.1:${port}`, thread);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("static assets are compressed, revalidated with an ETag, and answered 304 unchanged", async () => {
  await withDashboard(async (base) => {
    const source = readFileSync(join(PUBLIC_DIR, "app.js"));
    const response = await get(`${base}/app.js`, { "accept-encoding": "br" });
    assert.equal(response.headers["content-encoding"], "br");
    assert.equal(response.headers["vary"], "accept-encoding");
    assert.equal(brotliDecompressSync(response.body).toString(), source.toString());
    // Worth the trouble only if it actually shrinks the file.
    assert.ok(response.body.length * 2 < source.length, `${response.body.length} vs ${source.length}`);
    assert.equal(Number(response.headers["content-length"]), response.body.length);

    const etag = response.headers["etag"] as string;
    assert.ok(etag);
    assert.equal(response.headers["cache-control"], "no-cache");
    const revalidated = await get(`${base}/app.js`, { "if-none-match": etag, "accept-encoding": "br" });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);

    const css = readFileSync(join(PUBLIC_DIR, "style.css")).toString();
    // A client that asks for nothing still gets the file it can read.
    const plain = await get(`${base}/style.css`, { "accept-encoding": "identity" });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.body.toString(), css);

    const gzipped = await get(`${base}/style.css`, { "accept-encoding": "gzip" });
    assert.equal(gzipped.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(gzipped.body).toString(), css);

    // `br;q=0` means "not brotli", not "brotli is fine".
    const refused = await get(`${base}/style.css`, { "accept-encoding": "br;q=0, gzip" });
    assert.equal(refused.headers["content-encoding"], "gzip");
  });
});

test("fonts are cached forever and left alone — woff2 is already compressed", async () => {
  await withDashboard(async (base) => {
    const response = await get(`${base}/fonts/grenze-700.woff2`, { "accept-encoding": "br, gzip" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "font/woff2");
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.body.subarray(0, 4).toString(), "wOF2");
  });
});

test("an unknown path still renders the app shell", async () => {
  await withDashboard(async (base) => {
    const response = await get(`${base}/does/not/exist`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers["content-type"]), /text\/html/);
    assert.match(response.body.toString(), /<title>eleven<\/title>/);

    // Nor does a walk out of the public dir reach anything else.
    const escape = await get(`${base}/../../package.json`);
    assert.match(escape.body.toString(), /<title>eleven<\/title>/);
  });
});

test("API reads carry an ETag, so an unchanged answer costs a 304", async () => {
  await withDashboard(async (base) => {
    const response = await get(`${base}/api/threads`);
    const etag = response.headers["etag"] as string;
    assert.ok(etag);
    assert.equal(response.headers["cache-control"], "no-cache");

    const revalidated = await get(`${base}/api/threads`, { "if-none-match": etag });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);
  });
});

test("the thread list leaves out the session file path; the detail view keeps it", async () => {
  await withDashboard(async (base, thread) => {
    const [listed] = JSON.parse((await get(`${base}/api/threads`)).body.toString());
    assert.equal(listed.id, thread.id);
    assert.equal(listed.sessionFile, undefined);
    assert.equal(listed.state, "current");

    const detail = JSON.parse((await get(`${base}/api/threads/${thread.id}`)).body.toString());
    assert.equal(detail.thread.sessionFile, thread.sessionFile);
  });
});

test("the overview lists workspaces by name — the pages that edit one read /config", async () => {
  await withDashboard(async (base) => {
    const overview = JSON.parse((await get(`${base}/api/overview`)).body.toString());
    assert.deepEqual(overview.workspaces, ["agent"]);
  });
});

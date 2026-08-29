import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The media store resolves its directory from the environment at import time,
// so the state dir has to be redirected before anything reaches for it — hence
// the dynamic imports below. Each test file is its own process, so this cannot
// leak into another one.
const STATE_DIR = mkdtempSync(join(tmpdir(), "eleven-media-state-"));
process.env.ELEVEN_STATE_DIR = STATE_DIR;

const { startDashboard } = await import("../src/dashboard/server.ts");
const { resolveMediaPath } = await import("../src/media-store.ts");

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

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const json = (response: Response) => JSON.parse(response.body.toString());

/** A one-pixel PNG, so an "is this really an image" assertion has real bytes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Turn {
  text: string;
  images?: { type: string; data: string; mimeType: string }[];
}

/** Enough of a daemon to accept a message: one workspace, one thread, and a
 *  transcription command that is just `echo`, so a "voice note" is testable
 *  without a speech model. */
async function withDashboard(run: (base: string, thread: { id: string }, turns: Turn[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "eleven-media-ws-"));
  const thread = { id: "11111111-2222-3333-4444-555555555555", sessionKey: "dashboard:agent:11111111", workspace: "agent", createdAt: 1, lastActivityAt: 2 };
  const port = await freePort();
  const workspaces = { agent: { path: dir } };
  const turns: Turn[] = [];
  const config = {
    raw: { workspaces, dashboard: { host: "127.0.0.1", port } },
    resolved: { workspaces, dashboard: { host: "127.0.0.1", port }, models: [], transcription: { command: "echo transcribed {{file}}" } },
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
    handle: async (incoming: Turn) => {
      turns.push({ text: incoming.text, images: incoming.images });
      return undefined;
    },
  };
  const telegram = { status: () => [], pairing: { list: () => [], on: () => {} } };
  const dashboard = startDashboard(config as never, gateway as never, telegram as never);
  try {
    await run(`http://127.0.0.1:${port}`, thread, turns);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Upload a file the way the composer does: the body is the file itself. */
async function upload(base: string, name: string, type: string, bytes: Buffer) {
  const response = await send(`${base}/api/media?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": type },
    body: bytes,
  });
  assert.equal(response.status, 201, response.body.toString());
  return json(response) as { id: string; bytes: number; mime: string };
}

test("an uploaded file reaches the turn as a path the agent can open, and as an image the model can see", async () => {
  await withDashboard(async (base, thread, turns) => {
    const stored = await upload(base, "shot.png", "image/png", PNG);
    assert.equal(stored.mime, "image/png");
    assert.equal(stored.bytes, PNG.length);
    assert.ok(existsSync(join(STATE_DIR, "media", stored.id)), "the upload is on disk");

    const response = await send(`${base}/api/threads/${thread.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what is this", attachments: [{ id: stored.id, mime: "image/png" }] }),
    });
    assert.equal(response.status, 202);

    const turn = turns.at(-1)!;
    assert.match(turn.text, /^what is this\n\n\[media attached: .*shot\.png \(image\/png\)\]$/);
    assert.ok(turn.text.includes(join(STATE_DIR, "media", stored.id)), "the note names the stored path");
    assert.equal(turn.images?.length, 1);
    assert.equal(turn.images?.[0].mimeType, "image/png");
    assert.equal(turn.images?.[0].data, PNG.toString("base64"));
  });
});

test("a recording is transcribed on arrival, like a Telegram voice note", async () => {
  await withDashboard(async (base, thread, turns) => {
    const stored = await upload(base, "voice-note.webm", "audio/webm", Buffer.from("not really opus"));
    const response = await send(`${base}/api/threads/${thread.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", attachments: [{ id: stored.id, mime: "audio/webm", voice: true }] }),
    });
    assert.equal(response.status, 202);
    const delivered = json(response) as { message: string };
    assert.match(delivered.message, /\[Transcript\]\ntranscribed .*voice-note\.webm/);
    assert.match(delivered.message, /\[media attached: .*voice-note\.webm \(audio\/webm\)\]/);

    const turn = turns.at(-1)!;
    assert.equal(turn.text, delivered.message, "the composer gets the exact body sent to the agent");
    assert.equal(turn.images?.length ?? 0, 0);
  });
});

test("a stored file is served back only as a type it is safe to render here", async () => {
  await withDashboard(async (base) => {
    const stored = await upload(base, "shot.png", "image/png", PNG);

    const image = await send(`${base}/api/media/${stored.id}?type=image/png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers["content-type"], "image/png");
    assert.equal(image.headers["content-disposition"], "inline");
    assert.equal(image.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(image.body, PNG);

    // The whole point of the allowlist: an uploaded document asked for as
    // markup would be a script running in the origin that drives the agent.
    for (const type of ["text/html", "image/svg+xml", "application/javascript"]) {
      const hostile = await send(`${base}/api/media/${stored.id}?type=${encodeURIComponent(type)}`);
      assert.equal(hostile.status, 200);
      assert.equal(hostile.headers["content-type"], "application/octet-stream", type);
      assert.equal(hostile.headers["content-disposition"], "attachment", type);
    }

    // No type at all is a download too, not a sniffed guess.
    const bare = await send(`${base}/api/media/${stored.id}`);
    assert.equal(bare.headers["content-type"], "application/octet-stream");
  });
});

test("media ids are bare filenames — nothing that walks out of the media directory", async () => {
  for (const id of ["../eleven.json", "a/b", "..", "./x", "", "/etc/passwd"]) {
    assert.equal(resolveMediaPath(id), undefined, id);
  }
  assert.equal(resolveMediaPath("abcd1234-shot.png"), join(STATE_DIR, "media", "abcd1234-shot.png"));
});

test("an attachment the store no longer has says so instead of failing the turn", async () => {
  await withDashboard(async (base, thread, turns) => {
    const response = await send(`${base}/api/threads/${thread.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "here", attachments: [{ id: "deadbeef-gone.png", mime: "image/png" }] }),
    });
    assert.equal(response.status, 202);
    assert.match(turns.at(-1)!.text, /no longer stored/);
  });
});

test("an upload past the ceiling is refused, and an empty one is not stored", async () => {
  await withDashboard(async (base) => {
    const tooBig = await send(`${base}/api/media?name=huge.bin`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(26 * 1024 * 1024),
    });
    assert.equal(tooBig.status, 413);

    const empty = await send(`${base}/api/media?name=nothing.bin`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(0),
    });
    assert.equal(empty.status, 400);
  });
});

test("a cross-origin page cannot upload into the media store", async () => {
  await withDashboard(async (base) => {
    const response = await send(`${base}/api/media?name=evil.png`, {
      method: "POST",
      headers: { "content-type": "image/png", origin: "https://evil.example" },
      body: PNG,
    });
    assert.equal(response.status, 403);
  });
});

test.after(() => rmSync(STATE_DIR, { recursive: true, force: true }));

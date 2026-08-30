import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A JSON request with a body — the state-changing half of the API. */
function post(url: string, body: unknown = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/** What the fakes below recorded, so a test can assert on side effects that
 *  never leave the daemon (a rotation, an abort, a dropped input burst). */
interface Spy {
  rotated: { sessionKey: string; workspace?: string }[];
  interrupted: string[];
  discarded: string[];
  fresh: { id: string; sessionKey: string; workspace: string };
  /** Every turn the dashboard asked the gateway to run. */
  handled: { sessionKey: string; text: string; modelScopes?: unknown[]; appends?: string[] }[];
  /** A thread that lives in a Telegram topic — the composer is not its home. */
  topic: { id: string; sessionKey: string; workspace: string };
}

/** Enough of a daemon for the HTTP layer: one workspace, one thread, no bots. */
async function withDashboard(run: (base: string, thread: { id: string; sessionFile: string }, spy: Spy) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "eleven-dashboard-http-"));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");
  // A workspace with something to discover in it: the skills view reads the
  // directory, so an empty temp dir would let a broken one look correct.
  mkdirSync(join(dir, ".agents", "skills", "pancake"), { recursive: true });
  writeFileSync(join(dir, ".agents", "skills", "pancake", "SKILL.md"), "---\nname: pancake\ndescription: Flips a pancake.\n---\n\nbody\n");
  const thread = {
    id: "11111111-2222-3333-4444-555555555555",
    sessionKey: "dashboard:agent:11111111",
    workspace: "agent",
    sessionFile,
    createdAt: 1_000,
    lastActivityAt: 2_000,
    title: "a thread",
  };
  // A second thread, living in a Telegram topic that is configured to run on a
  // model of its own — what the composer must honor when it types into it.
  const topicThread = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    sessionKey: "telegram:main:-1001:topic:7",
    workspace: "agent",
    createdAt: 500,
    lastActivityAt: 1_500,
    title: "a topic thread",
  };
  const topicScope = { title: "eleven", appendSystemPrompt: "this one is TypeScript", models: [{ model: "claude-code/opus" }] };
  const groupScope = {
    title: "Sesh",
    appendSystemPrompt: "work on the repo named after the topic",
    models: [{ model: "openai-codex/gpt-5" }],
    topics: { "7": topicScope },
  };
  const port = await freePort();
  const channel = { type: "telegram", name: "main", token: "t", groups: { "-1001": groupScope } };
  const config = {
    raw: { workspaces: { agent: { path: dir } }, dashboard: { host: "127.0.0.1", port } },
    resolved: { workspaces: { agent: { path: dir, channels: [channel] } }, dashboard: { host: "127.0.0.1", port }, models: [] },
    channels: () => [{ workspace: "agent", channel }],
    turnModels: () => [],
    configuredModelRefs: () => [],
    on: () => {},
  };
  const spy: Spy = {
    rotated: [],
    interrupted: [],
    discarded: [],
    fresh: { id: "99999999-8888-7777-6666-555555555555", sessionKey: thread.sessionKey, workspace: thread.workspace },
    handled: [],
    topic: topicThread,
  };
  const gateway = {
    on: () => {},
    handle: async (incoming: { sessionKey: string; text: string; modelScopes?: unknown[]; appends?: string[] }) => {
      spy.handled.push(incoming);
      return undefined;
    },
    threads: {
      list: () => [thread, topicThread],
      get: (id: string) =>
        id === thread.id ? thread : id === topicThread.id ? topicThread : id === spy.fresh.id ? spy.fresh : undefined,
      isCurrent: (id: string) => id !== thread.id || !spy.rotated.length,
      current: () => thread,
    },
    isThreadRunning: () => false,
    requests: { list: async () => [] },
    liveTurn: () => undefined,
    interrupt: async (sessionKey: string) => (spy.interrupted.push(sessionKey), true),
    newThread: (sessionKey: string, workspace?: string) => (spy.rotated.push({ sessionKey, workspace }), spy.fresh),
  };
  const telegram = {
    status: () => [],
    pairing: { list: () => [], on: () => {} },
    discardPending: (sessionKey: string) => (spy.discarded.push(sessionKey), true),
  };
  const dashboard = startDashboard(config as never, gateway as never, telegram as never);
  try {
    await run(`http://127.0.0.1:${port}`, thread, spy);
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

// The dashboard runs straight off the checkout, so editing a module while the
// daemon is up used to serve the new app.js next to the live-turn.js cached
// before the edit — the browser then died on an import of an export that the
// stale half did not have.
test("an asset edited under the running daemon is served fresh, not from the cache", async () => {
  const scratch = join(PUBLIC_DIR, "regression-asset.js");
  writeFileSync(scratch, "export const answer = 41;\n");
  try {
    await withDashboard(async (base) => {
      const first = await get(`${base}/regression-asset.js`, { "accept-encoding": "identity" });
      assert.equal(first.body.toString(), "export const answer = 41;\n");

      // Same byte count on purpose: only the mtime says it moved on, and a
      // size-only check would sail right past this.
      writeFileSync(scratch, "export const answer = 42;\n");

      const second = await get(`${base}/regression-asset.js`, { "accept-encoding": "identity" });
      assert.equal(second.body.toString(), "export const answer = 42;\n");
      assert.notEqual(second.headers["etag"], first.headers["etag"]);

      // And a browser holding the old body is told to take the new one.
      const revalidated = await get(`${base}/regression-asset.js`, { "if-none-match": String(first.headers["etag"]), "accept-encoding": "identity" });
      assert.equal(revalidated.status, 200);
      assert.equal(revalidated.body.toString(), "export const answer = 42;\n");
    });
  } finally {
    rmSync(scratch, { force: true });
  }
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

test("token usage is read off the transcript, per day, per model and per thread", async () => {
  await withDashboard(async (base, thread) => {
    const paid = (minutesAgo: number, provider: string, model: string, usage: Record<string, number>) => {
      const at = Date.now() - minutesAgo * 60_000;
      return JSON.stringify({
        type: "message",
        timestamp: new Date(at).toISOString(),
        message: {
          role: "assistant", provider, model, timestamp: at, content: [{ type: "text", text: "answered" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...usage, cost: { total: usage.cost ?? 0 } },
        },
      });
    };
    writeFileSync(thread.sessionFile, [
      paid(90, "openai-codex", "gpt-5", { input: 4_000, output: 300, cost: 0.1 }),
      // Long after the cache went cold, and on another model: both at once.
      paid(10, "claude-code", "opus", { cacheRead: 120_000, cacheWrite: 30_000, output: 900, cost: 1.4 }),
    ].join("\n") + "\n");

    const response = await get(`${base}/api/usage/tokens?days=7`);
    assert.equal(response.status, 200);
    const report = JSON.parse(response.body.toString());
    assert.equal(report.days, 7);
    assert.equal(report.total.responses, 2);
    assert.equal(report.total.cacheRead, 120_000);
    assert.equal(Math.round(report.total.cost * 100), 150);
    assert.deepEqual(report.byModel.map((entry: { model: string }) => entry.model), ["claude-code/opus", "openai-codex/gpt-5"]);
    assert.equal(report.byThread.length, 1);
    assert.equal(report.byThread[0].id, thread.id);
    assert.equal(report.waste.coldResponses, 1, "the second response lost the cache to idleness and to a model switch");
    assert.equal(report.waste.idleResponses, 1);
    assert.equal(report.waste.modelSwitchResponses, 1);
    assert.ok(report.byDay.length >= 1 && report.byDay.length <= 2);

    // The same numbers ride along with the thread the transcript belongs to.
    const detail = JSON.parse((await get(`${base}/api/threads/${thread.id}`)).body.toString());
    assert.equal(detail.thread.usage.responses, 2);
    assert.equal(detail.thread.usage.cacheWrite, 30_000);
    assert.equal(detail.thread.usage.lastModel, "claude-code/opus");
    // A nested runtime's row sums a whole tool loop, so it is never offered as
    // a context-window reading.
    assert.equal(detail.thread.usage.lastPromptTokens, undefined);
  });
});

test("a window that isn't a sane number of days is refused rather than guessed at", async () => {
  await withDashboard(async (base) => {
    for (const days of ["0", "-3", "1.5", "banana", "99999"]) {
      assert.equal((await get(`${base}/api/usage/tokens?days=${days}`)).status, 400, `days=${days}`);
    }
    assert.equal((await get(`${base}/api/usage/tokens`)).status, 200, "no window means the default one");
  });
});

test("a fresh thread can be started inside the conversation on screen — the dashboard's /new", async () => {
  await withDashboard(async (base, thread, spy) => {
    const response = await post(`${base}/api/threads/${thread.id}/new`);
    assert.equal(response.status, 201);
    const started = JSON.parse(response.body);
    // The new thread belongs to the *same* conversation — that is the whole
    // point: the launcher already knows how to mint a dashboard-only one.
    assert.equal(started.id, spy.fresh.id);
    assert.equal(started.sessionKey, thread.sessionKey);
    assert.deepEqual(spy.rotated, [{ sessionKey: thread.sessionKey, workspace: "agent" }]);
    // Fresh means fresh, as in Telegram: the in-flight turn and any buffered
    // input stay with the thread being left behind.
    assert.deepEqual(spy.interrupted, [thread.sessionKey]);
    assert.deepEqual(spy.discarded, [thread.sessionKey]);
  });
});

test("starting a fresh thread on an unknown thread is a 404, not a rotation", async () => {
  await withDashboard(async (base, _thread, spy) => {
    const response = await post(`${base}/api/threads/00000000-0000-0000-0000-000000000000/new`);
    assert.equal(response.status, 404);
    assert.deepEqual(spy.rotated, []);
  });
});

test("a workspace's skills come with its detail read — what the thread's skills view shows", async () => {
  await withDashboard(async (base) => {
    const detail = JSON.parse((await get(`${base}/api/workspaces/agent`)).body.toString());
    assert.deepEqual(detail.skills, [{ name: "pancake", description: "Flips a pancake." }]);
    // And only with it: listing every workspace must not open every skill pack.
    const [listed] = JSON.parse((await get(`${base}/api/workspaces`)).body.toString());
    assert.equal(listed.skills, undefined);
  });
});

test("a thread that belongs to a channel refuses a turn typed here", async () => {
  await withDashboard(async (base, _thread, spy) => {
    // A dashboard turn carries no channel tool and nothing delivers it: run one
    // in a Telegram thread and the reply lands in the transcript and never
    // reaches the chat — invisible to the person still reading the conversation
    // on the other end. It also ran on the workspace's models and prompt rather
    // than the topic's, which is how this was first noticed.
    const response = await post(`${base}/api/threads/${spy.topic.id}/message`, { text: "ship it" });
    assert.equal(response.status, 409);
    assert.match(JSON.parse(response.body).error, /lives in Telegram · Sesh · eleven/);
    assert.deepEqual(spy.handled, []);
  });
});

test("the dashboard's own thread still takes one", async () => {
  await withDashboard(async (base, thread, spy) => {
    const response = await post(`${base}/api/threads/${thread.id}/message`, { text: "hello" });
    assert.equal(response.status, 202);
    assert.deepEqual(spy.handled.map((turn) => turn.text), ["hello"]);
  });
});

test("a thread says whether it can be typed into — the composer obeys it", async () => {
  await withDashboard(async (base, thread, spy) => {
    const listed = JSON.parse((await get(`${base}/api/threads`)).body.toString());
    assert.deepEqual(
      listed.map((view: { id: string; composable: boolean }) => [view.id, view.composable]),
      [[thread.id, true], [spy.topic.id, false]],
    );
    // And in the read the pane actually opens with.
    const detail = JSON.parse((await get(`${base}/api/threads/${spy.topic.id}`)).body.toString());
    assert.equal(detail.thread.composable, false);
  });
});

test("the overview lists workspaces by name — the pages that edit one read /config", async () => {
  await withDashboard(async (base) => {
    const overview = JSON.parse((await get(`${base}/api/overview`)).body.toString());
    assert.deepEqual(overview.workspaces, ["agent"]);
  });
});

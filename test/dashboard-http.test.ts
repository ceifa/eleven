import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { startDashboard } from "../src/dashboard/server.ts";
import { TurnFailure } from "../src/agent/runner.ts";
import { continuePrompt } from "../src/channels/failover.ts";

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
  channelOps: { action: string; sessionKey: string; name?: string; text?: string; persistent?: boolean }[];
  rotated: { sessionKey: string; workspace?: string }[];
  interrupted: string[];
  discarded: string[];
  fresh: { id: string; sessionKey: string; workspace: string };
  /** Every turn the dashboard asked the gateway to run. */
  handled: { sessionKey: string; text: string; models?: unknown[]; modelScopes?: unknown[]; appends?: string[]; customTools?: { name: string }[] }[];
  /** A thread that lives in a Telegram topic — the composer is not its home. */
  topic: { id: string; sessionKey: string; workspace: string };
}

/** Enough of a daemon for the HTTP layer: one workspace, one thread, no bots. */
async function withDashboard(
  run: (base: string, thread: { id: string; sessionFile: string }, spy: Spy) => Promise<void>,
  options: { autoFailover?: boolean; handle?: (incoming: Spy["handled"][number], attempt: number) => Promise<unknown> } = {},
) {
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
  const topicScope = {
    title: "eleven",
    appendSystemPrompt: "this one is TypeScript",
    models: [{ model: "claude-code/opus" }],
    iconColor: 0x6fb9f0,
    iconEmojiId: "5312536423851630001",
  };
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
    resolved: { workspaces: { agent: { path: dir, channels: [channel] } }, dashboard: { host: "127.0.0.1", port }, models: [], autoFailover: options.autoFailover },
    channels: () => [{ workspace: "agent", channel }],
    turnModels: () => [],
    configuredModelRefs: () => [],
    on: () => {},
  };
  const spy: Spy = {
    channelOps: [],
    rotated: [],
    interrupted: [],
    discarded: [],
    fresh: { id: "99999999-8888-7777-6666-555555555555", sessionKey: thread.sessionKey, workspace: thread.workspace },
    handled: [],
    topic: topicThread,
  };
  const gateway = {
    on: () => {},
    handle: async (incoming: Spy["handled"][number]) => {
      spy.handled.push(incoming);
      return options.handle?.(incoming, spy.handled.length);
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
    destinations: async () => [{ sessionKey: "discord:home:1:20", kind: "forum", title: "inbox" }],
    describe: async (sessionKey: string) => ({ sessionKey, kind: "thread", title: "Decision", parent: "discord:home:1:20" }),
    openThread: async (sessionKey: string, name: string, text: string, persistent?: boolean) => {
      spy.channelOps.push({ action: "open", sessionKey, name, text, persistent });
      return { sessionKey: "discord:home:1:30", threadId: "new-id", url: "https://discord.com/channels/1/30", recorded: true };
    },
    prompt: async (sessionKey: string, text: string) => { spy.channelOps.push({ action: "prompt", sessionKey, text }); },
    archive: async (sessionKey: string) => { spy.channelOps.push({ action: "archive", sessionKey }); },
    status: () => [],
    pairing: { list: () => [], on: () => {} },
    discardPending: (sessionKey: string) => (spy.discarded.push(sessionKey), true),
    avatar: async (sessionKey: string) =>
      sessionKey === topicThread.sessionKey ? { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), type: "image/jpeg" } : undefined,
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
    // `private`: the tunnel's CDN caches .js and .css by default, and with a
    // bare `no-cache` it kept serving a stylesheet a day older than the page.
    assert.equal(response.headers["cache-control"], "private, no-cache");
    assert.equal((await get(`${base}/style.css`)).headers["cache-control"], "private, no-cache");
    assert.equal((await get(`${base}/`)).headers["cache-control"], "private, no-cache");
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

// Everything the SPA fallback doesn't recognise is answered with index.html,
// which is the right default and exactly wrong for these two: a manifest served
// as text/html is ignored and a worker served as text/html is refused — both
// silently, leaving an app that never becomes installable and no error anywhere
// saying why.
test("the manifest and the worker are served as themselves, not as the app shell", async () => {
  await withDashboard(async (base) => {
    const manifest = await get(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers["content-type"], "application/manifest+json");
    assert.equal(JSON.parse(manifest.body.toString()).start_url, "/#/threads");

    const worker = await get(`${base}/sw.js`, { "accept-encoding": "identity" });
    assert.equal(worker.status, 200);
    assert.match(String(worker.headers["content-type"]), /^text\/javascript/);
    assert.match(worker.body.toString(), /addEventListener\("fetch"/);
    // And it revalidates rather than sitting in the browser's cache: it is the
    // one file that decides what every other one is allowed to be.
    assert.equal(worker.headers["cache-control"], "private, no-cache");

    const icon = await get(`${base}/icons/icon-192.png`, { "accept-encoding": "br, gzip" });
    assert.equal(icon.headers["content-type"], "image/png");
    assert.equal(icon.headers["content-encoding"], undefined); // a PNG is compressed already
    assert.equal(icon.body.subarray(1, 4).toString(), "PNG");
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
    assert.equal(response.headers["cache-control"], "private, no-cache");

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

test("a Telegram conversation's card carries Telegram's face for it, served by the daemon", async () => {
  await withDashboard(async (base, _thread, spy) => {
    const threads = JSON.parse((await get(`${base}/api/threads`)).body.toString());
    const topic = threads.find((thread: { id: string }) => thread.id === spy.topic.id);
    // The topic's emoji, versioned by its id so a new icon is a new URL; and
    // the topic's own colour for the bubble under it.
    assert.deepEqual(topic.avatar, {
      kind: "emoji",
      src: `/api/avatars/${encodeURIComponent(spy.topic.sessionKey)}?v=5312536423851630001`,
    });
    assert.equal(topic.avatarColor, "#6fb9f0");
    // The dashboard's own thread has nothing to draw but its initial.
    const local = threads.find((thread: { id: string }) => thread.id !== spy.topic.id);
    assert.equal(local.avatar, undefined);
    assert.equal(local.avatarColor, undefined);

    const picture = await get(`${base}${topic.avatar.src}`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers["content-type"], "image/jpeg");
    assert.equal(picture.headers["cache-control"], "private, max-age=86400");
    assert.deepEqual([...picture.body], [0xff, 0xd8, 0xff, 0xe0]);

    const missing = await get(`${base}/api/avatars/${encodeURIComponent("telegram:main:-1002")}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["cache-control"], "private, max-age=300");
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
    // Nothing delivers a dashboard turn to the chat: run one
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

test("a turn typed here can offer buttons to click", async () => {
  await withDashboard(async (base, thread, spy) => {
    await post(`${base}/api/threads/${thread.id}/message`, { text: "pick one" });
    assert.deepEqual(spy.handled[0].customTools?.map((tool) => tool.name), ["dashboard"]);
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

/** A CLI turn that dies on its lead model after running tools, then answers on the next. */
function quotaSpentMidTurn(attempt: number) {
  if (attempt > 1) return Promise.resolve({ text: "done", model: "claude-code/opus", status: "completed", sessionFile: "" });
  const failure = new TurnFailure("provider error on claude-code/opus: usage limit reached", "claude-code/opus", [{ model: "claude-code/opus", account: "wiv" }]);
  failure.hiddenToolCalls = [{ id: "1", name: "Bash", args: { command: "git status" } }];
  return Promise.reject(failure);
}

async function cliRun(base: string, id: string) {
  for (;;) {
    const run = JSON.parse((await get(`${base}/api/threads/${id}/run`)).body.toString());
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("with auto-failover on, a CLI turn that died after its tools ran continues on the untried tail", async () => {
  await withDashboard(async (base, _thread, spy) => {
    assert.equal((await post(`${base}/api/threads`, { workspace: "agent", text: "run the cron", source: "cli" })).status, 201);

    const run = await cliRun(base, spy.fresh.id);

    // A cron has nobody to press Continue: the retry is the run's answer.
    assert.equal(run.status, "done");
    assert.equal(run.result.text, "done");
    assert.equal(spy.handled.length, 2);
    assert.deepEqual(spy.handled[1].models, [{ model: "claude-code/opus", account: "wiv" }]);
    assert.equal(spy.handled[1].text, continuePrompt([{ name: "Bash", args: { command: "git status" } }]));
  }, { autoFailover: true, handle: (_incoming, attempt) => quotaSpentMidTurn(attempt) });
});

test("with auto-failover off, a CLI turn that died after its tools ran just fails", async () => {
  await withDashboard(async (base, _thread, spy) => {
    await post(`${base}/api/threads`, { workspace: "agent", text: "run the cron", source: "cli" });

    const run = await cliRun(base, spy.fresh.id);

    assert.equal(run.status, "error");
    assert.match(run.error, /usage limit reached/);
    assert.equal(spy.handled.length, 1);
  }, { handle: (_incoming, attempt) => quotaSpentMidTurn(attempt) });
});


test("channel control creates a recorded conversation and routes work and archival through its adapter", async () => {
  await withDashboard(async (base, thread, spy) => {
    const opened = await post(`${base}/api/channels/thread`, { sessionKey: "discord:home:1:20", name: "Decision", text: "Context", persistent: true });
    assert.equal(opened.status, 201);
    assert.equal(JSON.parse(opened.body).sessionKey, "discord:home:1:30");
    assert.deepEqual(spy.channelOps[0], { action: "open", sessionKey: "discord:home:1:20", name: "Decision", text: "Context", persistent: true });
    assert.equal((await post(`${base}/api/threads/${thread.id}/prompt`, { text: "Continue this item" })).status, 202);
    assert.equal((await post(`${base}/api/threads/${thread.id}/archive`)).status, 202);
    assert.deepEqual(spy.channelOps.slice(1).map((op) => op.action), ["prompt", "archive"]);
    assert.equal(spy.handled.length, 0, "does not use a dashboard turn that loses channel tools and delivery");
  });
});

test("channel creation validates before dispatch and remote turns reject an old generation", async () => {
  await withDashboard(async (base, thread, spy) => {
    assert.equal((await post(`${base}/api/channels/thread`, { sessionKey: "x", name: "", text: "Context" })).status, 400);
    assert.equal(spy.channelOps.length, 0);
    await post(`${base}/api/threads/${thread.id}/new`);
    assert.equal((await post(`${base}/api/threads/${thread.id}/prompt`, { text: "Do not run" })).status, 409);
    assert.equal(spy.channelOps.length, 0);
  });
});


test("channel metadata can be discovered and looked up without a bot token in the response", async () => {
  await withDashboard(async (base) => {
    const list = await get(`${base}/api/channels/destinations`);
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body.toString())[0].kind, "forum");
    const detail = await get(`${base}/api/channels/destination?sessionKey=${encodeURIComponent("discord:home:1:30")}`);
    assert.equal(detail.status, 200);
    assert.equal(JSON.parse(detail.body.toString()).parent, "discord:home:1:20");
    assert.equal((await get(`${base}/api/channels/destination`)).status, 400);
  });
});

test("a voice turn is answered at once and polled, spoken-style and without buttons", async () => {
  await withDashboard(async (base, thread, spy) => {
    const started = await post(`${base}/api/threads/${thread.id}/voice`, { text: "como está o trânsito?" });
    assert.equal(started.status, 202, started.body);
    const run = await cliRun(base, thread.id);
    assert.equal(run.status, "done");
    assert.equal(run.result.text, "Livre.");

    const turn = spy.handled.at(-1)!;
    assert.equal(turn.text, "como está o trânsito?");
    assert.match(turn.appends?.join("\n") ?? "", /hands-free voice conversation/);
    // Nobody can press a button while driving.
    assert.equal(turn.customTools, undefined);
  }, { handle: async () => ({ text: "Livre.", model: "m", status: "completed", sessionFile: "" }) });
});

test("voice is only for the dashboard's own threads", async () => {
  await withDashboard(async (base, _thread, spy) => {
    const response = await post(`${base}/api/threads/${spy.topic.id}/voice`, { text: "oi" });
    assert.equal(response.status, 409);
    assert.equal(spy.handled.length, 0);
  });
});

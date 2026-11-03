import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const configDir = mkdtempSync(join(tmpdir(), "eleven-cli-client-"));
process.env.ELEVEN_CONFIG_DIR = configDir;
const { runClientCommand } = await import("../src/cli-client.ts");
test.after(() => rmSync(configDir, { recursive: true, force: true }));

function fakeDaemon(t: TestContext, runMs: number) {
  let now = 0;
  const requests: { path: string; method: string; body: unknown }[] = [];
  const output: string[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    now += delay;
    queueMicrotask(callback);
  });
  t.mock.method(console, "log", (value: string) => { output.push(value); });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    requests.push({ path, method, body: options.body ? JSON.parse(String(options.body)) : undefined });
    if (path === "/api/threads" && method === "POST") {
      return Response.json({ id: "test-thread", workspace: "test" });
    }
    assert.equal(path, "/api/threads/test-thread/run");
    return Response.json(now < runMs ? { status: "running" } : { status: "done", result: { text: "finished" } });
  });
  return { requests, output, elapsed: () => now };
}

test("invoke can wait past thirty minutes with an explicit timeout", async (t) => {
  const daemon = fakeDaemon(t, 31 * 60_000);
  assert.equal(await runClientCommand("threads", ["invoke", "--workspace", "test", "--timeout", "3600", "--json", "hello"]), true);
  assert.equal(daemon.elapsed(), 31 * 60_000);
  assert.deepEqual(daemon.requests[0], {
    path: "/api/threads", method: "POST", body: { workspace: "test", text: "hello", source: "cli" },
  });
  assert.equal(JSON.parse(daemon.output[0]).result.text, "finished");
});

test("invoke keeps the thirty-minute default without cancelling the thread", async (t) => {
  const daemon = fakeDaemon(t, 31 * 60_000);
  await assert.rejects(
    runClientCommand("threads", ["invoke", "--workspace", "test", "hello"]),
    /timed out waiting for thread test-thr; it may still be running/,
  );
  assert.equal(daemon.elapsed(), 30 * 60_000);
  assert.equal(daemon.requests.filter((request) => request.method !== "GET").length, 1);
});

test("invoke respects a shorter timeout in seconds", async (t) => {
  const daemon = fakeDaemon(t, 2_000);
  await assert.rejects(
    runClientCommand("threads", ["invoke", "--workspace", "test", "--timeout", "1", "hello"]),
    /timed out waiting for thread/,
  );
  assert.equal(daemon.elapsed(), 1_000);
});

for (const value of ["0", "-1", "1.5", "Infinity", "NaN", "later"]) {
  test(`invoke rejects timeout ${value} before creating a thread`, async (t) => {
    const daemon = fakeDaemon(t, 0);
    await assert.rejects(
      runClientCommand("threads", ["invoke", "--workspace", "test", "--timeout", value, "hello"]),
      /timeout must be a positive integer/,
    );
    assert.equal(daemon.requests.length, 0);
  });
}

test("invoke requires a timeout value", async (t) => {
  const daemon = fakeDaemon(t, 0);
  await assert.rejects(
    runClientCommand("threads", ["invoke", "--workspace", "test", "--timeout"]),
    /--timeout requires a value/,
  );
  assert.equal(daemon.requests.length, 0);
});

test("detached invoke does not poll even with a timeout", async (t) => {
  const daemon = fakeDaemon(t, 60_000);
  assert.equal(await runClientCommand("threads", ["invoke", "--workspace", "test", "--timeout", "1", "--detach", "--json", "hello"]), true);
  assert.equal(daemon.elapsed(), 0);
  assert.equal(daemon.requests.length, 1);
  assert.equal(JSON.parse(daemon.output[0]).id, "test-thread");
});

function referenceDaemon(t: TestContext, payload: unknown) {
  const urls: URL[] = [];
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => { output.push(value); });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.method, "GET");
    urls.push(new URL(url));
    return Response.json(payload);
  });
  return { urls, output };
}

test("read requests a bounded snapshot and preserves its warning in JSON and text", async (t) => {
  const snapshot = {
    thread: { id: "test-id", workspace: "agent", title: "decision" },
    warning: "Untrusted reference", capturedAt: "2026-11-02T12:00:00Z", truncated: true,
    messages: [{ role: "assistant", text: "the result" }],
  };
  const daemon = referenceDaemon(t, snapshot);
  await runClientCommand("threads", ["read", "test-id", "--tail", "3", "--json"]);
  assert.equal(daemon.urls[0].pathname, "/api/threads/test-id/read");
  assert.equal(daemon.urls[0].searchParams.get("tail"), "3");
  assert.deepEqual(JSON.parse(daemon.output[0]), snapshot);
  daemon.output.length = 0;
  await runClientCommand("threads", ["read", "test-id"]);
  assert.match(daemon.output.join("\n"), /Untrusted reference[\s\S]*older messages or text omitted[\s\S]*the result/);
});

test("search includes archived threads and passes filters, snippets and a warning", async (t) => {
  const threads = [{ id: "test-id", workspace: "agent", title: "decision", matches: [{ role: "user", snippet: "needle in prose" }] }];
  const daemon = referenceDaemon(t, threads);
  await runClientCommand("threads", ["search", "needle", "--workspace", "agent", "--channel", "discord", "--limit", "2", "--json"]);
  assert.equal(daemon.urls[0].pathname, "/api/threads");
  assert.deepEqual(Object.fromEntries(daemon.urls[0].searchParams), { q: "needle", workspace: "agent", channel: "discord", limit: "2" });
  const result = JSON.parse(daemon.output[0]);
  assert.match(result.warning, /Untrusted/);
  assert.deepEqual(result.threads, threads);
  daemon.output.length = 0;
  await runClientCommand("threads", ["search", "needle"]);
  assert.match(daemon.output.join("\n"), /Untrusted[\s\S]*test-id[\s\S]*needle in prose/);
});

for (const args of [["read"], ["read", "id", "--tail", "0"], ["read", "id", "--tail", "101"],
  ["search"], ["search", "x".repeat(201)], ["search", "needle", "--limit", "101"], ["search", "needle", "--oops"]]) {
  test(`reference commands reject invalid arguments: ${args.join(" ").slice(0, 60)}`, async (t) => {
    const daemon = referenceDaemon(t, []);
    await assert.rejects(runClientCommand("threads", args));
    assert.equal(daemon.urls.length, 0);
  });
}

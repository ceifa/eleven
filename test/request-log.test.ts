import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// REQUESTS_DIR resolves from the environment at import time.
process.env.ELEVEN_STATE_DIR = mkdtempSync(join(tmpdir(), "eleven-requests-"));

const { RequestLog, requestLogFile } = await import("../src/threads/request-log.ts");

const line = (id: string, at: number, model: string, payload: unknown) => `${JSON.stringify({ id, at, model, payload })}\n`;

test("a log written before this process starts is indexed without its payloads being parsed", async () => {
  const file = requestLogFile("indexed");
  mkdirSync(join(file, ".."), { recursive: true });
  // Payloads span several read chunks, so meta and line ends land across them.
  const big = "x".repeat(700_000);
  const lines = [
    line("aaaaaaaa", 1, "openai/gpt", { input: big }),
    line("bbbbbbbb", 2, "a \"quoted\" model", { input: "small" }),
    line("cccccccc", 3, "openai/gpt", { input: big.slice(1) }),
  ];
  writeFileSync(file, lines.join("") + '{"id":"dddddddd","at":4,"model":"cut","payload":{"input":"xx');

  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof parse>[1]) => {
    parsed += text.length;
    return parse(text, reviver);
  }) as typeof JSON.parse;
  let listed;
  try {
    listed = await new RequestLog().list("indexed");
  } finally {
    JSON.parse = parse;
  }

  // The crash-truncated tail stays out of the index.
  assert.deepEqual(listed, [
    { id: "aaaaaaaa", at: 1, model: "openai/gpt", bytes: lines[0].length - 1 },
    { id: "bbbbbbbb", at: 2, model: "a \"quoted\" model", bytes: lines[1].length - 1 },
    { id: "cccccccc", at: 3, model: "openai/gpt", bytes: lines[2].length - 1 },
  ]);
  assert.ok(parsed < 1_000, `parsed ${parsed} characters to build the index`);

  const log = new RequestLog();
  assert.deepEqual(await log.get("indexed", "cccccccc"), parse(lines[2]));
  assert.deepEqual(await log.get("indexed", "bbbbbbbb"), parse(lines[1]));
});

test("trimming a log of oversized payloads keeps the newest half readable", async () => {
  const file = requestLogFile("trimmed");
  mkdirSync(join(file, ".."), { recursive: true });
  const big = "y".repeat(5 * 1024 * 1024);
  writeFileSync(file, line("11111111", 1, "m", { input: big }));
  appendFileSync(file, "junk without meta\n");
  appendFileSync(file, line("22222222", 2, "m", { input: big.slice(1) }));

  const log = new RequestLog();
  const recorded = log.record("trimmed", "m", { input: "newest" });
  const listed = await log.list("trimmed"); // queued behind the record and its trim
  assert.deepEqual(listed.map((entry) => entry.id), ["22222222", recorded.id]);

  // Re-packed contiguously: a fresh index reads the same entries back from disk.
  const reread = new RequestLog();
  assert.deepEqual(await reread.list("trimmed"), listed);
  assert.deepEqual(await reread.get("trimmed", recorded.id), { id: recorded.id, at: recorded.at, model: "m", payload: { input: "newest" } });
  assert.equal(((await reread.get("trimmed", "22222222")) as { payload: { input: string } }).payload.input.length, big.length - 1);
  assert.equal(readFileSync(file, "utf8").split("\n").length, 3);
});

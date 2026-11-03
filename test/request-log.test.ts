import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// REQUESTS_DIR resolves from the environment at import time.
process.env.ELEVEN_STATE_DIR = mkdtempSync(join(tmpdir(), "eleven-requests-"));

const { RequestLog, requestLogFile } = await import("../src/threads/request-log.ts");
const { LoadedImages } = await import("../src/media-store.ts");

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

test("an oversized legacy log is trimmed to its newest request, still readable", async () => {
  const file = requestLogFile("trimmed");
  mkdirSync(join(file, ".."), { recursive: true });
  const big = "y".repeat(5 * 1024 * 1024);
  writeFileSync(file, line("11111111", 1, "m", { input: big }));
  appendFileSync(file, "junk without meta\n");
  appendFileSync(file, line("22222222", 2, "m", { input: big.slice(1) }));

  const log = new RequestLog();
  const recorded = log.record("trimmed", "m", { input: "newest" });
  const listed = await log.list("trimmed"); // queued behind the record and its trim
  assert.deepEqual(listed.map((entry) => entry.id), [recorded.id]);

  // Re-packed contiguously: a fresh index reads the same entries back from disk.
  const reread = new RequestLog();
  assert.deepEqual(await reread.list("trimmed"), listed);
  assert.deepEqual(await reread.get("trimmed", recorded.id), { id: recorded.id, at: recorded.at, model: "m", payload: { input: "newest" } });
  assert.equal(readFileSync(file, "utf8").split("\n").length, 2);
});

test("each request is written as what changed since the one before, and read back whole", async () => {
  const system = "you are a helpful agent ".repeat(200);
  const tools = Array.from({ length: 20 }, (_, i) => ({ name: `tool${i}`, description: "does a thing ".repeat(50) }));
  const turn = (i: number) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} `.repeat(100) });
  const payloads: Record<string, unknown>[] = [];
  for (let i = 1; i <= 8; i++) payloads.push({ model: "gpt", instructions: system, tools, input: Array.from({ length: i }, (_, j) => turn(j)), stream: true });
  payloads.push({ ...payloads.at(-1)!, instructions: `${system} now with a date` }); // a value replaced
  const { stream: _, ...unstreamed } = payloads.at(-1)!;
  payloads.push({ ...unstreamed, input: [{ role: "user", content: "summary" }, turn(9)] }); // a key gone, history rewritten
  payloads.push({ ...payloads.at(-1)!, extra: undefined, input: [...(payloads.at(-1)!.input as unknown[]), turn(10)] });

  const log = new RequestLog();
  const recorded = payloads.map((payload) => log.record("deltas", "openai/gpt", payload));
  await log.get("deltas", recorded[0].id); // queued behind the writes
  const lines = readFileSync(requestLogFile("deltas"), "utf8").trim().split("\n");
  assert.equal(lines.filter((text) => text.includes('"base":')).length, payloads.length - 1);
  const full = payloads.reduce((total, payload) => total + JSON.stringify(payload).length, 0);
  assert.ok(lines.join("").length < full / 3, `wrote ${lines.join("").length} of ${full}`);

  // A fresh index (a restart) rebuilds every one of them from disk.
  const reread = new RequestLog();
  for (const [i, meta] of recorded.entries()) {
    assert.equal(meta.bytes, Buffer.byteLength(JSON.stringify(payloads[i])));
    assert.deepEqual(await reread.get("deltas", meta.id), { id: meta.id, at: meta.at, model: "openai/gpt", payload: JSON.parse(JSON.stringify(payloads[i])) });
  }
  // It has nothing in memory to build on, so it starts over from a full payload.
  const restarted = reread.record("deltas", "openai/gpt", payloads[0]);
  await reread.get("deltas", restarted.id);
  assert.ok(!readFileSync(requestLogFile("deltas"), "utf8").trim().split("\n").at(-1)!.includes('"base":'));
});

test("trimming a log of deltas cuts where a full payload starts", async () => {
  const log = new RequestLog();
  const input: string[] = [];
  const recorded = [];
  // Every request adds ~300 KB: deltas run out of room every ~13, and the log over its cap.
  for (let i = 0; i < 40; i++) {
    input.push(`${i}`.padEnd(300_000, "z"));
    recorded.push({ meta: log.record("chain", "m", { input: [...input] }), input: [...input] });
  }
  const listed = await log.list("chain");
  assert.ok(listed.length < recorded.length && listed.length > 1, `kept ${listed.length}`);
  assert.ok(!readFileSync(requestLogFile("chain"), "utf8").split("\n", 1)[0].includes('"base":'));
  const reread = new RequestLog();
  for (const { meta, input: sent } of recorded.slice(-listed.length)) {
    assert.deepEqual((await reread.get("chain", meta.id) as { payload: unknown }).payload, { input: sent });
  }
});

test("an image the thread stores is logged as its path", async () => {
  const images = new LoadedImages();
  const data = Buffer.alloc(4096, 7).toString("base64");
  images.set("/media/abc.png", data);
  const log = new RequestLog();
  const meta = log.record("images", "m", {
    input: [{ content: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] }],
    messages: [{ content: [{ type: "image", source: { type: "base64", data } }] }],
    other: data.slice(1),
  }, images);
  assert.deepEqual((await log.get("images", meta.id) as { payload: unknown }).payload, {
    input: [{ content: [{ type: "input_image", image_url: "[image: /media/abc.png]" }] }],
    messages: [{ content: [{ type: "image", source: { type: "base64", data: "[image: /media/abc.png]" } }] }],
    other: data.slice(1),
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { queryMatcher, searchTranscript } from "../src/threads/search.ts";

const at = "2026-08-28T12:00:00.000Z";
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", id: role, parentId: null, timestamp: at, message: { role, content, ...extra } });

function sessionFile(dir: string, lines: string[]): string {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const match = (file: string, query: string, limit = 5) => searchTranscript(file, queryMatcher(query)!, limit);

test("a query matches across case and accents, in both directions", () => {
  const matcher = queryMatcher("condominio")!;
  assert.ok(matcher.test("pagar o Condomínio hoje"));
  assert.ok(queryMatcher("CONDOMÍNIO")!.test("o condominio venceu"));
  // A run of whitespace matches a line break — prose wraps, queries don't.
  assert.ok(queryMatcher("deploy failed")!.test("the deploy\nfailed twice"));
  // Regex metacharacters are text, not syntax.
  assert.ok(queryMatcher("a.b")!.test("a.b"));
  assert.equal(queryMatcher("a.b")!.test("axb"), false);
  assert.equal(queryMatcher("   "), undefined);
});

test("search finds prose in both directions and clips a snippet around the hit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-search-"));
  try {
    const file = sessionFile(dir, [
      JSON.stringify({ type: "session", id: "s", parentId: null }),
      message("user", "quanto custou o condomínio esse mês?"),
      message("assistant", [{ type: "text", text: `${"filler ".repeat(60)}o condomínio veio 840 reais${" mais texto".repeat(60)}` }]),
    ]);

    const matches = await match(file, "condominio");
    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((m) => m.role), ["user", "assistant"]);
    assert.equal(matches[0].timestamp, at);
    assert.equal(matches[0].snippet, "quanto custou o condomínio esse mês?");
    // The long one is clipped on both sides, and says so.
    assert.ok(matches[1].snippet.startsWith("…"), matches[1].snippet);
    assert.ok(matches[1].snippet.endsWith("…"), matches[1].snippet);
    assert.ok(matches[1].snippet.includes("o condomínio veio 840 reais"));
    assert.ok(matches[1].snippet.length < 250);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search ignores tool results — a hit in a file the agent read is not a hit in the conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-search-tools-"));
  try {
    const file = sessionFile(dir, [
      message("assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/etc/deployment.conf" } }]),
      message("toolResult", "deployment: rollback pending", { toolCallId: "c1" }),
      JSON.stringify({ type: "custom", id: "x", parentId: null, customType: "eleven:tool-calls", data: { calls: [{ id: "c1", name: "deployment" }] } }),
    ]);
    assert.deepEqual(await match(file, "deployment"), []);

    const spoken = sessionFile(dir, [message("user", "how did the deployment go?")]);
    assert.equal((await match(spoken, "deployment")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search stops at the limit it was given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-search-limit-"));
  try {
    const file = sessionFile(dir, Array.from({ length: 20 }, (_, i) => message("user", `hit number ${i}`)));
    assert.equal((await match(file, "hit", 3)).length, 3);
    assert.equal((await match(file, "hit", 50)).length, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The scanner reads a block at a time and tests each block whole, so the line
// that spans two reads is the one it could lose. It is also the common case in
// a real transcript, where a single assistant turn is longer than a read.
test("a match in a line that spans two reads is still found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-search-boundary-"));
  try {
    const lines = [];
    let bytes = 0;
    while (bytes < 256 * 1024 - 200) {
      const line = message("assistant", [{ type: "text", text: "x".repeat(400) }]);
      lines.push(line);
      bytes += line.length + 1;
    }
    lines.push(message("user", `${"y".repeat(150)} straddling-needle ${"z".repeat(300)}`));
    const file = sessionFile(dir, lines);

    const matches = await match(file, "straddling-needle");
    assert.equal(matches.length, 1);
    assert.ok(matches[0].snippet.includes("straddling-needle"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session too large to be a message is skipped without stalling the scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-search-huge-"));
  try {
    const file = sessionFile(dir, [
      // A tool result several reads long: it must not be accumulated whole, and
      // the scan must resynchronize on the next line rather than give up.
      message("toolResult", `${"noise ".repeat(400_000)} straddling-needle`, { toolCallId: "c1" }),
      message("user", "the needle is here"),
    ]);
    const matches = await match(file, "needle");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].snippet, "the needle is here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session file that is gone reads as no matches, not as a failure", async () => {
  assert.deepEqual(await match(join(tmpdir(), "eleven-missing-session.jsonl"), "anything"), []);
});

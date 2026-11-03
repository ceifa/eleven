import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// MEDIA_DIR resolves from the environment at import time.
const stateDir = mkdtempSync(join(tmpdir(), "eleven-thread-files-"));
process.env.ELEVEN_STATE_DIR = stateDir;

const { deleteReferencedMedia } = await import("../src/media-store.ts");
const { sessionIdOf } = await import("../src/threads/gc.ts");
const { MEDIA_DIR } = await import("../src/paths.ts");

test("deleting a session's media finds every reference, wherever the scan's chunks split it", async () => {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const names = ["0a1b2c3d-photo.jpg", "4e5f6a7b-voice_note.ogg", "8c9d0e1f-scan.pdf", "aabbccdd-kept.png"];
  for (const name of names) writeFileSync(join(MEDIA_DIR, name), "media");
  const reference = (name: string) => `${MEDIA_DIR}/${name}`;
  // Each reference straddles the boundary of a 256 KiB read at a different
  // point; multibyte text before them shifts characters off byte offsets.
  const chunk = 256 * 1024;
  const pad = (to: number, current: string) => "ç".repeat(Math.floor((to - Buffer.byteLength(current)) / 2)) + "x".repeat((to - Buffer.byteLength(current)) % 2);
  let body = "";
  body += pad(chunk - 10, body) + reference(names[0]) + '"\n';
  body += pad(2 * chunk - reference(names[1]).length + 3, body) + reference(names[1]) + "\n";
  body += reference(names[0]) + " again, then one at the very end: " + reference(names[2]);
  const sessionFile = join(stateDir, "session.jsonl");
  writeFileSync(sessionFile, body);

  assert.equal(await deleteReferencedMedia(sessionFile), 3);
  assert.deepEqual(names.map((name) => existsSync(join(MEDIA_DIR, name))), [false, false, false, true]);
  assert.equal(await deleteReferencedMedia(join(stateDir, "missing.jsonl")), 0);
});

test("a session's id comes from its header, without loading the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-session-id-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  const file = manager.getSessionFile()!;
  assert.equal(await sessionIdOf(file), manager.getSessionId());

  // Unreadable header or no file at all: the id pi put in the file name.
  const id = "01a13506-160c-71d7-bafa-039346ac37fd";
  const broken = join(dir, `2026-10-13T11-29-13-740Z_${id}.jsonl`);
  writeFileSync(broken, "not a header\n");
  assert.equal(await sessionIdOf(broken), id);
  assert.equal(await sessionIdOf(join(dir, `gone_${id}.jsonl`)), id);
  assert.equal(await sessionIdOf(join(dir, "gone.jsonl")), undefined);
});

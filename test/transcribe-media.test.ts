import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The media store resolves its directory from the environment at import time.
const STATE_DIR = mkdtempSync(join(tmpdir(), "eleven-transcribe-state-"));
process.env.ELEVEN_STATE_DIR = STATE_DIR;

const { flattenTranscript, transcribeMedia } = await import("../src/media-store.ts");

test.after(() => rmSync(STATE_DIR, { recursive: true, force: true }));

test("a segment continuing a word is joined without a space", () => {
  // What whisper-server actually returns: the 60-character wrap fell inside
  // "adicionada", and the continuation segment carries no leading space.
  const wrapped = " Desse modo, é provável que uma nota foi simplesmente ad\nicionada como rótulo.\n";
  assert.equal(flattenTranscript(wrapped), "Desse modo, é provável que uma nota foi simplesmente adicionada como rótulo.");
});

test("a segment starting a new word is joined with a space", () => {
  const wrapped = " Os idiomas oficiais de Barcelona são catalão e espanhol. Qu\nase metade das pessoas preferem falar catalão.\n Grande parte o compreende.\n";
  assert.equal(
    flattenTranscript(wrapped),
    "Os idiomas oficiais de Barcelona são catalão e espanhol. Quase metade das pessoas preferem falar catalão. Grande parte o compreende.",
  );
});

test("single-line and empty transcripts survive untouched", () => {
  assert.equal(flattenTranscript("já está numa linha só\n"), "já está numa linha só");
  assert.equal(flattenTranscript("\n\n  \n"), "");
});

test("transcribeMedia flattens the command output", async () => {
  const text = await transcribeMedia("/tmp/does-not-matter.oga", "printf ' um flick de uma thr\\nead para outra.\\n'");
  assert.equal(text, "um flick de uma thread para outra.");
});

test("transcribeMedia still reports an empty transcript", async () => {
  assert.equal(await transcribeMedia("/tmp/does-not-matter.oga", "printf '\\n \\n'"), "(empty transcript)");
});

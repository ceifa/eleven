import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The media store resolves its directory from the environment at import time.
const STATE_DIR = mkdtempSync(join(tmpdir(), "eleven-inbound-media-"));
process.env.ELEVEN_STATE_DIR = STATE_DIR;

const { collectInboundMedia } = await import("../src/channels/telegram/media.ts");

test.after(() => rmSync(STATE_DIR, { recursive: true, force: true }));

const VOICE_MESSAGE = { voice: { file_id: "voice-1", file_size: 1024, mime_type: "audio/ogg" } };

/** A context whose getFile always answers; only the file download is scripted. */
function context(message: unknown) {
  return { message, api: { getFile: async () => ({ file_path: "voice/file_1.oga" }) } } as never;
}

/** `fetch` answering the scripted outcomes in order, counting its calls. */
function scriptedFetch(outcomes: Array<Response | Error>) {
  const calls: string[] = [];
  const fetcher = async (url: string | URL | Request) => {
    const outcome = outcomes[calls.length] ?? outcomes[outcomes.length - 1];
    calls.push(String(url));
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

function withFetch<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("a voice note survives a transient failure on Telegram's file CDN", async () => {
  // The regression: one dropped connection turned the whole message into an
  // error note, so the audio reached the agent as nothing at all.
  const { calls, fetcher } = scriptedFetch([
    new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
    new Response(new Uint8Array([1, 2, 3])),
  ]);

  const result = await withFetch(fetcher, () => collectInboundMedia(context(VOICE_MESSAGE), "token", "printf 'oi\\n'"));

  assert.equal(calls.length, 2);
  assert.equal(result.transcript, "oi");
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /^\[media attached: .*voice\.oga \(audio\/ogg\)\]$/);
});

test("a voice note that keeps failing names itself and carries the cause", async () => {
  const { calls, fetcher } = scriptedFetch([
    new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.telegram.org"), { code: "EAI_AGAIN" }) }),
  ]);

  const result = await withFetch(fetcher, () => collectInboundMedia(context(VOICE_MESSAGE), "token", "printf 'oi\\n'"));

  assert.equal(calls.length, 3); // gave up only after the retries
  assert.equal(result.transcript, undefined);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /^\[voice message could not be processed: /);
  assert.match(result.notes[0], /EAI_AGAIN/); // the cause, not a bare "fetch failed"
});

test("a file that is gone is not retried", async () => {
  const { calls, fetcher } = scriptedFetch([new Response("nope", { status: 404 })]);

  const result = await withFetch(fetcher, () => collectInboundMedia(context(VOICE_MESSAGE), "token", "printf 'oi\\n'"));

  assert.equal(calls.length, 1);
  assert.match(result.notes[0], /\[voice message could not be processed: .*404/);
});

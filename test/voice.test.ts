import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error — a browser module without types; its logic runs in Node too.
import { speechChunks, speechDetector, spokenText, voiceLoop } from "../src/dashboard/public/voice.js";
import { synthesizeSpeech } from "../src/speech.ts";

/** Feed a detector one level every 50 ms, the rate the recorder samples at. */
function listen(levels: number[]) {
  const detector = speechDetector();
  return levels.map((level, index) => detector.sample(level, index * 50));
}
const repeat = (level: number, ms: number) => Array<number>(ms / 50).fill(level);

test("a phrase followed by a pause ends the take", () => {
  const phases = listen([...repeat(0.005, 600), ...repeat(0.1, 1500), ...repeat(0.005, 1500)]);
  assert.equal(phases.at(-1), "done");
  assert.ok(phases.includes("speech"));
});

test("steady road noise louder than a quiet room is not one endless sentence", () => {
  // The floor is measured after the tone. Without that, noise above the fixed
  // threshold started a "phrase" at once and held it open for 45 seconds.
  const phases = listen(repeat(0.06, 10_000));
  assert.ok(phases.every((phase) => phase === "quiet"), phases.join(","));
  const talking = listen([...repeat(0.06, 1000), ...repeat(0.3, 1500), ...repeat(0.06, 1500)]);
  assert.equal(talking.at(-1), "done");
});

test("a short knock does not send anything", () => {
  const phases = listen([...repeat(0.005, 600), ...repeat(0.2, 100), ...repeat(0.005, 3000)]);
  assert.ok(!phases.includes("done"));
});

test("a reply is read as speech, not as markup", () => {
  assert.equal(
    spokenText("## Pronto\n- **Reunião** às 15h, veja [o convite](https://x.y/z)\n```sh\nrm -rf /\n```\nhttps://a.b"),
    "Pronto Reunião às 15h, veja o convite",
  );
});

test("long replies are split at sentences, and nothing is dropped", () => {
  const text = "Primeira frase curta. Segunda frase um pouco maior que a primeira! Terceira? Fim";
  const chunks = speechChunks(text, 40);
  assert.ok(chunks.every((chunk: string) => chunk.length <= 40), chunks.join("|"));
  assert.equal(chunks[0], "Primeira frase curta.");
  assert.equal(chunks.join(" "), text);
  assert.deepEqual(speechChunks("a".repeat(10), 4), ["aaaa", "aaaa", "aa"]);
});

function fakeIo(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  let pending = false;
  const io = {
    log,
    state: (state: string) => log.push(state),
    pending: () => pending,
    record: async () => "blob",
    transcribe: async () => "como está o trânsito",
    heard: (text: string) => log.push(`heard:${text}`),
    ask: async (text: string) => { log.push(`ask:${text}`); pending = true; },
    reply: async () => { pending = false; return "**Livre** até o centro."; },
    answered: () => {},
    speak: async (text: string) => log.push(`speak:${text}`),
    setPending: (value: boolean) => { pending = value; },
    ...overrides,
  };
  return io;
}

test("one exchange: listen, ask once, speak the reply as plain speech", async () => {
  const controller = new AbortController();
  const io = fakeIo({ speak: async (text: string) => { io.log.push(`speak:${text}`); controller.abort(); } });
  await assert.rejects(voiceLoop(io, controller.signal));
  assert.deepEqual(io.log, ["listening", "transcribing", "heard:como está o trânsito", "ask:como está o trânsito", "thinking", "speaking", "speak:Livre até o centro."]);
});

test("a resumed conversation speaks the reply it was waiting for instead of asking again", async () => {
  const controller = new AbortController();
  const io = fakeIo({ speak: async (text: string) => { io.log.push(`speak:${text}`); controller.abort(); } });
  io.setPending(true);
  await assert.rejects(voiceLoop(io, controller.signal));
  assert.deepEqual(io.log, ["thinking", "speaking", "speak:Livre até o centro."]);
});

test("silence keeps listening instead of asking the agent", async () => {
  const controller = new AbortController();
  const heard = ["", "e aí"];
  const io = fakeIo({ transcribe: async () => heard.shift(), ask: async () => { controller.abort(); controller.signal.throwIfAborted(); } });
  await assert.rejects(voiceLoop(io, controller.signal));
  assert.deepEqual(io.log, ["listening", "transcribing", "listening", "transcribing", "heard:e aí"]);
});

test("a transcript that lands after a pause never starts a turn", async () => {
  const controller = new AbortController();
  const io = fakeIo({ transcribe: async () => { controller.abort(); return "manda a mensagem"; } });
  await assert.rejects(voiceLoop(io, controller.signal));
  assert.ok(!io.log.some((entry) => entry.startsWith("ask:")), io.log.join(","));
});

const WAV_COMMAND = "{ printf 'RIFF\\0\\0\\0\\0WAVE'; cat; } > {{file}}";

test("the speech command gets the text on stdin and its WAV comes back", async () => {
  const audio = await synthesizeSpeech("olá, Gabriel", WAV_COMMAND, new AbortController().signal);
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.subarray(12).toString(), "olá, Gabriel");
});

test("a speech command that writes something other than WAV is an error, not noise", async () => {
  await assert.rejects(synthesizeSpeech("x", "echo nope > {{file}}", new AbortController().signal), /must write a WAV/);
  await assert.rejects(synthesizeSpeech("x", "echo broken >&2; exit 3", new AbortController().signal), /broken/);
});

test("cancelling speech kills the whole command, not just the shell", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const speaking = synthesizeSpeech("x", "sleep 30; true > {{file}}", controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(speaking, /cancelled/);
  assert.ok(Date.now() - started < 5_000);
});

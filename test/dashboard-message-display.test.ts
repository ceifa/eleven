import assert from "node:assert/strict";
import test from "node:test";
import { presentMessage, sameMessage, splitEnvelope } from "../src/dashboard/public/message-display.js";
import { waveformLevels } from "../src/dashboard/public/waveform.js";

test("an upload receipt and the daemon's enriched attachment body are the same pending message", () => {
  const receipt = { role: "user", text: "[media attached: 079b607d-voice-note.webm (audio/webm)]" };
  const delivered = {
    role: "user",
    text: "[Transcript]\nhello from whisper\n\n[media attached: /tmp/eleven/media/079b607d-voice-note.webm (audio/webm)]",
  };

  assert.equal(sameMessage(receipt, delivered), true);
  assert.equal(sameMessage(receipt, { ...delivered, text: delivered.text.replace("079b607d", "deadbeef") }), false);
});

test("diagnostic presentation keeps the literal agent message instead of rendering its attachment", () => {
  const body = "[Transcript]\nhello\n\n[media attached: /tmp/abcd1234-voice.webm (audio/webm)]";

  assert.deepEqual(presentMessage(body, true), { text: body, media: [] });
  assert.deepEqual(presentMessage(body, false), {
    text: "[Transcript]\nhello",
    media: [{ id: "abcd1234-voice.webm", mime: "audio/webm" }],
  });
});

test("microphone levels are mirrored, bounded, and visibly react above silence", () => {
  const silent = waveformLevels(new Uint8Array(32), 7);
  assert.deepEqual(silent, Array(7).fill(0.08));

  const frequencies = new Uint8Array(32);
  frequencies[1] = 255;
  frequencies[2] = 128;
  frequencies[3] = 64;
  frequencies[4] = 16;
  const speaking = waveformLevels(frequencies, 7);

  assert.deepEqual(speaking, speaking.toReversed(), "the meter should fan out symmetrically");
  assert.equal(speaking[3], 1, "the centre should carry the strongest speech bin");
  assert.ok(speaking[2] > speaking[1]);
  assert.ok(speaking.every((level) => level >= 0.08 && level <= 1));
});

test("a group message's attribution becomes a caption, and only whole lines at a paragraph's head count", () => {
  const batch = "[Ana @ana]\n[Replying to you]\nfirst thought\n\n[Ana @ana]\n[Replying to you]\nsecond thought";
  assert.deepEqual(splitEnvelope(batch), {
    envelope: ["Ana @ana", "Replying to you"],
    text: "first thought\n\nsecond thought",
  });
  // Brackets somebody wrote are prose: mid-line, or a line inside a paragraph.
  assert.deepEqual(splitEnvelope("[WIP] fix the build\n[x] done"), { envelope: [], text: "[WIP] fix the build\n[x] done" });
  assert.deepEqual(splitEnvelope("[link](https://example.com)"), { envelope: [], text: "[link](https://example.com)" });
});

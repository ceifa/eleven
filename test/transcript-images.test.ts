import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";

const scratch = mkdtempSync(join(tmpdir(), "eleven-transcript-images-"));
process.env.ELEVEN_STATE_DIR = join(scratch, "state");
process.env.ELEVEN_CONFIG_DIR = join(scratch, "config");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const { modelRuntime } = await import("../src/agent/pi.ts");
const { Runner } = await import("../src/agent/runner.ts");
const { LoadedImages, loadImages, storeImages } = await import("../src/media-store.ts");
const { MEDIA_DIR } = await import("../src/paths.ts");

/** A one-pixel PNG of that colour: pi decodes the images it is given. */
function png(r: number, g: number, b: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const sizes = Buffer.alloc(8);
    sizes.writeUInt32BE(data.length, 0);
    sizes.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([sizes.subarray(0, 4), body, sizes.subarray(4)]);
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const PNG = png(255, 0, 0);
const PHOTO = png(0, 0, 255);

const imagesIn = (messages: Message[]) => messages.flatMap((message) =>
  Array.isArray(message.content) ? message.content.flatMap((block) => (block.type === "image" ? [block.data] : [])) : []);

/** The images each request carried, and whether the model has read the picture yet. */
const sent: string[][] = [];
const model = {
  id: "eyes", name: "eyes", api: "images-eyes", provider: "images", baseUrl: "local://images",
  reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1_000,
} as Model;
const stream = (_model: Model, context: TranscriptContext) => {
  sent.push(imagesIn(context.messages));
  const asked = context.messages.at(-1)?.role === "user";
  const out = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: asked ? [{ type: "toolCall", id: `read-${sent.length}`, name: "read", arguments: { path: "pic.png" } }] : [{ type: "text", text: "a red pixel" }],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: asked ? "toolUse" : "stop", timestamp: Date.now(),
  };
  queueMicrotask(() => {
    out.push({ type: "done", reason: message.stopReason as "stop", message });
    out.end();
  });
  return out;
};
modelRuntime.registerNativeProvider({
  id: "images", name: "Images", baseUrl: "local://images",
  auth: { apiKey: { name: "unused", resolve: async () => ({ auth: { apiKey: "unused" }, source: "stored" }) } },
  getModels: () => [model], stream, streamSimple: stream,
});

test("a transcript keeps its images in the media store and every request still sends them", async () => {
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "pic.png"), Buffer.from(PNG, "base64"));
  const request = {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "sessions"), workspacePath: workspace, tools: ["read" as const], models: [{ model: "images/eyes" }],
  };

  const first = await new Runner().submit("thread", { ...request, text: "what is this?", images: [{ type: "image", data: PHOTO, mimeType: "image/png" }] });
  // The read result's picture reaches the model in the same turn it was taken.
  assert.deepEqual(sent.map((images) => images.length), [1, 2]);
  assert.equal(sent[1][0], PHOTO);
  const picture = sent[1][1];
  assert.ok(picture.length > 50);

  const transcript = readFileSync(first!.sessionFile, "utf8");
  assert.ok(!transcript.includes(PHOTO) && !transcript.includes(picture), "base64 left in the transcript");
  const stored = readdirSync(MEDIA_DIR);
  assert.equal(stored.length, 2);
  for (const name of stored) {
    assert.match(name, /^thread-[0-9a-f]{64}\.png$/);
    assert.ok(transcript.includes(join(MEDIA_DIR, name)));
  }

  // A cold session reads them back from the media store.
  await new Runner().submit("thread", { ...request, sessionFile: first!.sessionFile, text: "and again?" });
  assert.deepEqual(sent[2], [PHOTO, picture]);
});

test("storing an image names it by its content and loading it reads it back", async () => {
  const loaded = new LoadedImages();
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }, { type: "image" as const, data: PHOTO, mimeType: "image/jpeg" }], timestamp: 1 };
  const stored = storeImages(message, loaded, "a/b")!;
  const again = storeImages({ ...message, timestamp: 2 }, loaded, "a/b")!;
  assert.deepEqual(stored.content[1], again.content[1]);
  const path = (stored.content[1] as { path: string }).path;
  assert.match(path, /\/a_b-[0-9a-f]{64}\.jpg$/);
  assert.equal(readFileSync(path).toString("base64"), PHOTO);
  assert.equal(storeImages({ role: "user", content: "text only", timestamp: 3 }, loaded, "a/b"), undefined);
  // Not canonical base64: it could not come back byte for byte, so it stays.
  const odd = { role: "user" as const, content: [{ type: "image" as const, data: "a b", mimeType: "image/png" }], timestamp: 4 };
  assert.equal(storeImages(odd, loaded, "a/b")!.content[0], odd.content[0]);

  assert.deepEqual(await loadImages([stored], new LoadedImages()), [message]);
  const plain = [{ role: "user" as const, content: "no images", timestamp: 5 }];
  assert.equal(await loadImages(plain, loaded), plain);
  rmSync(path);
  assert.deepEqual((await loadImages([stored], new LoadedImages()))[0], {
    ...message, content: [message.content[0], { type: "text", text: `[image no longer stored: ${path}]` }],
  });
  assert.ok(!existsSync(path));
});

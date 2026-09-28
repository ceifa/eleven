import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AvatarCache, imageType, topicEmoji } from "../src/channels/telegram/avatars.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

function withCache(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "eleven-avatars-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a picture is typed by its bytes, and a Lottie sticker is no picture", () => {
  assert.equal(imageType(JPEG), "image/jpeg");
  assert.equal(imageType(WEBP), "image/webp");
  assert.equal(imageType(Buffer.from([0x1f, 0x8b, 0x08])), undefined);
});

test("a conversation's picture is fetched once, and so is the fact that it has none", async () => {
  await withCache(async (dir) => {
    const cache = new AvatarCache(dir);
    let fetches = 0;
    const photo = async () => (fetches++, JPEG);
    assert.deepEqual(await cache.get("chat-main-1", 60_000, photo), { bytes: JPEG, type: "image/jpeg" });
    assert.deepEqual(await cache.get("chat-main-1", 60_000, photo), { bytes: JPEG, type: "image/jpeg" });
    assert.equal(fetches, 1);

    // A new cache over the same directory: it survives a restart.
    const again = new AvatarCache(dir);
    assert.deepEqual(await again.get("chat-main-1", 60_000, photo), { bytes: JPEG, type: "image/jpeg" });
    assert.equal(fetches, 1);

    let blank = 0;
    const none = async () => (blank++, undefined);
    assert.equal(await cache.get("chat-main-2", 60_000, none), undefined);
    assert.equal(await cache.get("chat-main-2", 60_000, none), undefined);
    assert.equal(blank, 1);
  });
});

test("a stale picture is served while it refreshes, and a failed refresh keeps it", async () => {
  await withCache(async (dir) => {
    let now = Date.now();
    const cache = new AvatarCache(dir, () => now);
    await cache.get("chat-main-1", 1_000, async () => JPEG);

    now += 5_000;
    let release!: (value: Buffer) => void;
    const slow = new Promise<Buffer>((resolve) => (release = resolve));
    // Past its TTL: the old face now, not a wait on Telegram.
    assert.deepEqual(await cache.get("chat-main-1", 1_000, () => slow), { bytes: JPEG, type: "image/jpeg" });
    release(WEBP);
    await slow;
    await new Promise((resolve) => setTimeout(resolve, 20));
    now += 100;
    assert.deepEqual(await cache.get("chat-main-1", 1_000, async () => assert.fail("fresh")), { bytes: WEBP, type: "image/webp" });

    // The bot is down: what was known is still the answer, and nothing new
    // was written in its place.
    now += 5_000;
    const down = async () => Promise.reject(new Error("offline"));
    assert.deepEqual(await cache.get("chat-main-1", 1_000, down), { bytes: WEBP, type: "image/webp" });
    assert.equal(await cache.get("chat-main-9", 1_000, down), undefined);
  });
});

test("a cached answer older than its TTL is asked for again", async () => {
  await withCache(async (dir) => {
    writeFileSync(join(dir, "chat-main-1"), "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(dir, "chat-main-1"), old, old);
    const cache = new AvatarCache(dir);
    // "No photo" a while ago, and a photo since: the refresh runs behind the
    // miss, and the next ask sees it.
    assert.equal(await cache.get("chat-main-1", 1_000, async () => JPEG), undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await cache.get("chat-main-1", 1_000, async () => assert.fail("fresh")), { bytes: JPEG, type: "image/jpeg" });
  });
});

test("an animated topic emoji is drawn from its thumbnail, a still one from itself", async () => {
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(String(url));
    return new Response(JPEG);
  }) as typeof fetch;
  try {
    const api = (sticker: object) => ({
      getCustomEmojiStickers: async () => [sticker],
      getFile: async (fileId: string) => ({ file_id: fileId, file_unique_id: fileId, file_path: `stickers/${fileId}` }),
    });
    const animated = { file_id: "lottie", is_animated: true, is_video: false, thumbnail: { file_id: "thumb" } };
    assert.deepEqual(await topicEmoji(api(animated) as never, "T", "111"), JPEG);
    const still = { file_id: "still", is_animated: false, is_video: false };
    assert.deepEqual(await topicEmoji(api(still) as never, "T", "222"), JPEG);
    assert.equal(await topicEmoji(api({ file_id: "lottie", is_animated: true, is_video: false }) as never, "T", "333"), undefined);
    assert.deepEqual(fetched, ["https://api.telegram.org/file/botT/stickers/thumb", "https://api.telegram.org/file/botT/stickers/still"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

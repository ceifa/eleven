import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Context } from "grammy";
import { download } from "./media.ts";
import { logger } from "../../log.ts";

const log = logger("telegram/avatars");

// Telegram's small chat photo is a 160px jpeg of ~10 KB, a topic emoji's
// thumbnail about the same; anything near this cap is not what we asked for.
export const MAX_AVATAR_BYTES = 128 * 1024;

export interface Avatar {
  bytes: Buffer;
  type: string;
}

/** The picture's type from its first bytes — Telegram's file paths say .jpg or
 *  .webp, but what matters is what the browser will be told to render. Anything
 *  else (an animated sticker's gzipped Lottie, say) is no picture at all. */
export function imageType(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "\x89PNG") return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

/** A chat's picture — the person's, in a DM. undefined when it has none, or
 *  hides it from the bot. */
export async function chatPhoto(api: Pick<Api, "getChat" | "getFile">, token: string, chatId: number): Promise<Buffer | undefined> {
  const fileId = (await api.getChat(chatId)).photo?.small_file_id;
  return fileId ? capped(await download({ api } as Pick<Context, "api">, token, fileId)) : undefined;
}

/** The custom emoji a forum topic wears as its icon, as a still image. Most
 *  are animated, and those only come still as their thumbnail. */
export async function topicEmoji(api: Pick<Api, "getCustomEmojiStickers" | "getFile">, token: string, emojiId: string): Promise<Buffer | undefined> {
  const [sticker] = await api.getCustomEmojiStickers([emojiId]);
  const fileId = sticker?.thumbnail?.file_id ?? (sticker && !sticker.is_animated && !sticker.is_video ? sticker.file_id : undefined);
  return fileId ? capped(await download({ api } as Pick<Context, "api">, token, fileId)) : undefined;
}

const capped = (bytes: Buffer) => (bytes.length > MAX_AVATAR_BYTES ? undefined : bytes);

/**
 * Pictures for conversations, kept on disk so the dashboard doesn't cost the
 * Bot API a round trip per row it draws. An answer — a picture, or the fact that
 * there is none (an empty file) — is trusted for `ttlMs`; after that it is still
 * served while one refresh runs behind it, because a face a day old beats a
 * letter now. A failed fetch writes nothing: the next ask tries again, and
 * whatever was known before keeps being served.
 */
export class AvatarCache {
  private dir: string;
  private now: () => number;
  private inflight = new Map<string, Promise<Buffer | undefined>>();

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  async get(key: string, ttlMs: number, fetch: () => Promise<Buffer | undefined>): Promise<Avatar | undefined> {
    const file = join(this.dir, key.replaceAll(/[^\w.-]/g, "_"));
    const cached = await stat(file).then(async (info) => ({ bytes: await readFile(file), at: info.mtimeMs }), () => undefined);
    if (cached && this.now() - cached.at < ttlMs) return asAvatar(cached.bytes);
    const fresh = this.refresh(file, fetch);
    if (cached) {
      void fresh.catch(() => {});
      return asAvatar(cached.bytes);
    }
    return asAvatar(await fresh.catch(() => undefined));
  }

  private refresh(file: string, fetch: () => Promise<Buffer | undefined>): Promise<Buffer | undefined> {
    let running = this.inflight.get(file);
    if (running) return running;
    running = (async () => {
      try {
        // Deferred a tick, so a fetch that throws on the spot still finds itself
        // in `inflight` to be cleared from.
        const fetched = await Promise.resolve().then(fetch);
        const bytes = fetched && imageType(fetched) ? fetched : Buffer.alloc(0);
        await mkdir(this.dir, { recursive: true });
        // Written aside and moved in: a reader never sees half a picture.
        await writeFile(`${file}.tmp`, bytes);
        await rename(`${file}.tmp`, file);
        return bytes;
      } catch (error) {
        log.debug(`avatar unavailable for ${file}: ${error}`);
        throw error;
      } finally {
        this.inflight.delete(file);
      }
    })();
    this.inflight.set(file, running);
    return running;
  }
}

function asAvatar(bytes: Buffer | undefined): Avatar | undefined {
  const type = bytes?.length ? imageType(bytes) : undefined;
  return type ? { bytes: bytes!, type } : undefined;
}

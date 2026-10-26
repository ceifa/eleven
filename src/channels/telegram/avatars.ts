import type { Api, Context } from "grammy";
import { capped } from "../avatars.ts";
import { download } from "./media.ts";

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

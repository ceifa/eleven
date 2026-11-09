import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { APIMessage } from "discord-api-types/v10";

// The zero of every snowflake's clock (2015-01-01T00:00:00Z).
const DISCORD_EPOCH = 1_420_070_400_000n;
/** Older than this, a message is history, not something to answer now. */
export const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** More than this in one channel is a conversation that moved on without us. */
export const BACKFILL_MAX_PER_CHANNEL = 20;

/** The smallest snowflake Discord could have minted at `ms`. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(ms, Number(DISCORD_EPOCH))) - DISCORD_EPOCH) << 22n).toString();
}

export const isNewer = (id: string | null | undefined, than: string) => !!id && BigInt(id) > BigInt(than);

/**
 * The messages a channel got after `since`, oldest first — what a session that
 * started over never received. Ones the bot already reacted to were handled
 * before the drop. `undefined` means too many to replay one by one.
 */
export async function missedMessages(
  get: <T>(path: string) => Promise<T>,
  channelId: string,
  since: string,
): Promise<APIMessage[] | undefined> {
  const page = await get<APIMessage[]>(`/channels/${channelId}/messages?after=${since}&limit=${BACKFILL_MAX_PER_CHANNEL + 1}`);
  if (page.length > BACKFILL_MAX_PER_CHANNEL) return undefined;
  return page
    .filter((message) => !message.reactions?.some((reaction) => reaction.me))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * When the bot last knew it was hearing everything, kept on disk so a restart
 * knows where its blind spot began.
 */
export class Watermark {
  private file: string;
  value: number | undefined;

  constructor(file: string) {
    this.file = file;
    try {
      const at = JSON.parse(readFileSync(file, "utf8")).at;
      this.value = typeof at === "number" ? at : undefined;
    } catch {
      this.value = undefined;
    }
  }

  save(at: number): void {
    this.value = at;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ at }));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

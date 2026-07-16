import type { Api } from "grammy";
import { retryAfterMs } from "./retry.ts";
import { logger } from "../../log.ts";

const log = logger("telegram/stream");

const THROTTLE_MS = 900;
const MIN_INITIAL_CHARS = 60;
const MAX_FLOOD_SUSPEND_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Live preview of an in-progress reply using Telegram's native draft streaming
 * (`sendRichMessageDraft`, private chats only). Drafts are ephemeral — the final
 * text is delivered separately with sendRichMessage and the draft just fades.
 */
export class DraftStream {
  private api: Api;
  private chatId: number;
  private threadId: number | undefined;
  private draftId = Math.floor(Math.random() * 2 ** 31) + 1;
  private pending: string | undefined;
  private inflight = false;
  private scheduled = false;
  private lastSentAt = 0;
  private lastSent = "";
  private suspendedUntil = 0;
  private failures = 0;
  private dead = false;

  constructor(api: Api, chatId: number, threadId?: number) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;
  }

  /** Feed the full accumulated markdown; sends are throttled, latest text wins. */
  update(markdown: string) {
    if (this.dead || markdown.length < MIN_INITIAL_CHARS) return;
    this.pending = markdown;
    void this.flush();
  }

  /** Stop previewing. A scheduled/suspended flush would otherwise fire after the
   * final reply is delivered and re-post a stale draft; dead flushes are no-ops. */
  cancel() {
    this.dead = true;
    this.pending = undefined;
  }

  /** One pending timer at most — deltas arrive far faster than the throttle. */
  private schedule(delayMs: number) {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      void this.flush();
    }, delayMs);
  }

  private async flush() {
    if (this.inflight || this.dead) return;
    const now = Date.now();
    const wait = Math.max(this.lastSentAt + THROTTLE_MS, this.suspendedUntil) - now;
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const text = this.pending;
    if (text === undefined || text === this.lastSent) return;
    this.pending = undefined;
    this.inflight = true;
    try {
      await this.api.raw.sendRichMessageDraft({
        chat_id: this.chatId,
        message_thread_id: this.threadId,
        draft_id: this.draftId,
        rich_message: { markdown: text },
      });
      this.lastSent = text;
      this.failures = 0;
    } catch (error) {
      const floodWait = retryAfterMs(error, MAX_FLOOD_SUSPEND_MS);
      if (floodWait !== undefined) {
        this.suspendedUntil = Date.now() + floodWait;
      } else if (++this.failures >= MAX_CONSECUTIVE_FAILURES) {
        // Give up on previews; the final reply is unaffected.
        this.dead = true;
        log.warn(`draft streaming disabled for chat ${this.chatId}: ${error}`);
      }
    } finally {
      this.inflight = false;
      this.lastSentAt = Date.now();
      if (this.pending !== undefined) this.schedule(THROTTLE_MS);
    }
  }
}

import type { Api } from "grammy";
import type { InputRichMessage } from "@grammyjs/types";
import { retryAfterMs } from "./retry.ts";
import { logger } from "../../log.ts";

const log = logger("telegram/stream");

const THROTTLE_MS = 900;
const MIN_INITIAL_CHARS = 60;
// Hold the placeholder back just long enough that a turn answering instantly
// never flashes a "Thinking…" bubble before its reply.
const THINKING_DELAY_MS = 1_000;
// Telegram drops a draft that stops being refreshed after ~30s, and a turn can
// sit in a tool for minutes — re-send the placeholder to keep the bubble (and
// its stop button) alive.
const THINKING_KEEPALIVE_MS = 10_000;
const MAX_FLOOD_SUSPEND_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

/** What the draft currently shows: the reply so far, or a placeholder standing
 * in for work that hasn't produced prose yet. */
type Draft = { kind: "thinking"; label: string } | { kind: "text"; markdown: string };

/**
 * Live preview of an in-progress reply using Telegram's native draft streaming
 * (`sendRichMessageDraft`, private chats only). Drafts are ephemeral — the final
 * text is delivered separately with sendRichMessage and the draft just fades.
 *
 * The draft doubles as the turn's stop control: `can_stop` puts a stop button on
 * the bubble, and pressing it reaches the bot as a `stopped_message_generation`
 * update carrying `draftId`.
 */
export class DraftStream {
  /** Identifies this turn's draft — the key a stop press comes back with. */
  readonly draftId = Math.floor(Math.random() * 2 ** 31) + 1;
  private api: Api;
  private chatId: number;
  private threadId: number | undefined;
  private pending: Draft | undefined;
  private inflight = false;
  private scheduled = false;
  private keepalive: NodeJS.Timeout | undefined;
  private readonly readyAt = Date.now() + THINKING_DELAY_MS;
  private lastSentAt = 0;
  private lastSent = "";
  private hasText = false;
  private suspendedUntil = 0;
  private failures = 0;
  private dead = false;

  constructor(api: Api, chatId: number, threadId?: number) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;
  }

  /**
   * Show a placeholder while the turn has nothing to preview yet. Ignored once
   * prose is streaming: replacing visible text with "Thinking…" would erase the
   * very thing the preview exists to show. The label stays generic — a draft is
   * the model's output surface, not a window into its reasoning.
   */
  thinking(label = "Thinking…") {
    if (this.dead || this.hasText) return;
    this.pending = { kind: "thinking", label };
    void this.flush();
  }

  /** Feed the full accumulated markdown; sends are throttled, latest text wins. */
  update(markdown: string) {
    // Below the threshold the reply is still a fragment — keep whatever
    // placeholder is up rather than previewing three words.
    if (this.dead || markdown.length < MIN_INITIAL_CHARS) return;
    this.hasText = true;
    this.stopKeepalive();
    this.pending = { kind: "text", markdown };
    void this.flush();
  }

  /** Stop previewing. A scheduled/suspended flush would otherwise fire after the
   * final reply is delivered and re-post a stale draft; dead flushes are no-ops. */
  cancel() {
    this.dead = true;
    this.pending = undefined;
    this.stopKeepalive();
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

  private stopKeepalive() {
    if (this.keepalive) clearTimeout(this.keepalive);
    this.keepalive = undefined;
  }

  /** Re-post the same placeholder before Telegram expires it. Identical content
   * would be swallowed by the dedupe in flush(), so the refresh clears it. */
  private armKeepalive(draft: Draft) {
    this.stopKeepalive();
    this.keepalive = setTimeout(() => {
      this.keepalive = undefined;
      if (this.dead || this.hasText) return;
      this.lastSent = "";
      this.pending = draft;
      void this.flush();
    }, THINKING_KEEPALIVE_MS);
    this.keepalive.unref();
  }

  private async flush() {
    if (this.inflight || this.dead) return;
    const draft = this.pending;
    if (draft === undefined) return;
    const now = Date.now();
    // The first placeholder also waits out the flash guard; prose never does —
    // by the time it clears MIN_INITIAL_CHARS that delay has passed anyway.
    const floor = draft.kind === "thinking" && !this.lastSentAt ? this.readyAt : 0;
    const wait = Math.max(this.lastSentAt + THROTTLE_MS, this.suspendedUntil, floor) - now;
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const key = describe(draft);
    if (key === this.lastSent) return;
    this.pending = undefined;
    this.inflight = true;
    try {
      await this.api.raw.sendRichMessageDraft({
        chat_id: this.chatId,
        message_thread_id: this.threadId,
        draft_id: this.draftId,
        rich_message: render(draft),
        can_stop: true,
        // Leave the partial answer on screen when the user stops: the delivered
        // reply (or the next draft) supersedes it moments later anyway.
        keep_on_stop: true,
      });
      this.lastSent = key;
      this.failures = 0;
      if (draft.kind === "thinking") this.armKeepalive(draft);
    } catch (error) {
      const floodWait = retryAfterMs(error, MAX_FLOOD_SUSPEND_MS);
      if (floodWait !== undefined) {
        this.suspendedUntil = Date.now() + floodWait;
      } else if (++this.failures >= MAX_CONSECUTIVE_FAILURES) {
        // Give up on previews; the final reply is unaffected.
        this.dead = true;
        this.stopKeepalive();
        log.warn(`draft streaming disabled for chat ${this.chatId}: ${error}`);
      }
    } finally {
      this.inflight = false;
      this.lastSentAt = Date.now();
      if (this.pending !== undefined) this.schedule(THROTTLE_MS);
    }
  }
}

function render(draft: Draft): InputRichMessage<never> {
  return draft.kind === "text"
    ? { markdown: draft.markdown }
    : { blocks: [{ type: "thinking", text: draft.label }] };
}

function describe(draft: Draft): string {
  return draft.kind === "text" ? `t:${draft.markdown}` : `k:${draft.label}`;
}

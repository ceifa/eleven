import type { ImageContent } from "@earendil-works/pi-ai";

// Coalesce rapid arrivals (forwarded batches, albums) into a single turn: each
// message re-arms the quiet window; the cap bounds the total added latency.
const BURST_QUIET_MS = 1_500;
const BURST_MAX_WAIT_MS = 5_000;

/** Where a turn lands. The message that triggered it is the one acked and
 *  replied to — the newest one that has an id. */
export interface BurstTarget {
  triggerMessageId?: unknown;
}

interface Burst<T> {
  target: T;
  prompts: string[];
  images: ImageContent[];
  firstAt: number;
  timer: NodeJS.Timeout;
  /** Timer fired while a sibling was still preparing — flush when prep drains. */
  held?: boolean;
}

/**
 * Prepared messages per conversation, waiting out the quiet window before
 * becoming (or steering into) one turn. The flush runs outside the channel's
 * per-chat preparation lane, so a message landing mid-turn reaches the runner
 * (which steers it into the live turn) instead of waiting the whole turn out.
 */
export class Bursts<T extends BurstTarget> {
  private bursts = new Map<string, Burst<T>>();
  // Messages of a conversation between arrival and end of preparation. A burst
  // must not flush while this is non-zero: a fast photo would start a turn
  // without the slow audio (whisper) sent along with it.
  private preparing = new Map<string, number>();
  private run: (target: T, text: string, images: ImageContent[]) => void;
  private quietMs: number;
  private maxWaitMs: number;

  constructor(run: (target: T, text: string, images: ImageContent[]) => void, quietMs = BURST_QUIET_MS, maxWaitMs = BURST_MAX_WAIT_MS) {
    this.run = run;
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
  }

  /** A message of `key` entered preparation (queued, downloading, being
   *  transcribed). Call the returned release once it is done, whatever happened. */
  prepare(key: string): () => void {
    this.preparing.set(key, (this.preparing.get(key) ?? 0) + 1);
    return () => {
      const left = (this.preparing.get(key) ?? 1) - 1;
      if (left > 0) {
        this.preparing.set(key, left);
        return;
      }
      this.preparing.delete(key);
      if (this.bursts.get(key)?.held) this.flush(key);
    };
  }

  /** Queue a prepared message for its conversation's next turn. */
  enqueue(key: string, target: T, prompt: string, images: ImageContent[]): void {
    const burst = this.bursts.get(key);
    if (!burst) {
      this.bursts.set(key, {
        target,
        prompts: [prompt],
        images: [...images],
        firstAt: Date.now(),
        timer: setTimeout(() => this.flush(key), this.quietMs),
      });
      return;
    }
    clearTimeout(burst.timer);
    burst.prompts.push(prompt);
    burst.images.push(...images);
    burst.held = false; // fresh arrival → the quiet window runs again
    burst.target = { ...target, triggerMessageId: target.triggerMessageId ?? burst.target.triggerMessageId };
    const untilCap = burst.firstAt + this.maxWaitMs - Date.now();
    burst.timer = setTimeout(() => this.flush(key), Math.max(0, Math.min(this.quietMs, untilCap)));
  }

  /** Drop a conversation's pending burst (/stop and /new discard queued input). */
  discard(key: string): boolean {
    const burst = this.bursts.get(key);
    if (!burst) return false;
    clearTimeout(burst.timer);
    this.bursts.delete(key);
    return true;
  }

  /** Flush every pending burst now: the turn registers as in-flight, so a
   *  restart wakes the conversation instead of silently dropping the messages. */
  flushAll(): void {
    for (const [key, burst] of [...this.bursts]) {
      clearTimeout(burst.timer);
      this.flush(key);
    }
  }

  private flush(key: string): void {
    const burst = this.bursts.get(key);
    if (!burst) return;
    if (this.preparing.get(key)) {
      // A sibling message is still being prepared (e.g. a long transcription)
      // — hold; its release re-flushes when it drains.
      burst.held = true;
      return;
    }
    this.bursts.delete(key);
    this.run(burst.target, burst.prompts.join("\n\n"), burst.images);
  }
}

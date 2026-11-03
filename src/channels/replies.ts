import type { PendingTurns, PendingReply } from "../threads/pending.ts";
import type { ReplyOptions } from "./index.ts";
import { logger } from "../log.ts";

const log = logger("replies");

/** Uncertain sends require inspection rather than an automatic duplicate. */
export class DeliveryBlocked extends Error {}
export class DeliveryRevoked extends DeliveryBlocked {}

/** Retry saved final answers, never the model or its side effects. */
export class ReplyDelivery {
  private running = new Set<string>();
  private halted = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  private pending: PendingTurns;
  private send: (sessionKey: string, text: string, options: ReplyOptions) => Promise<unknown>;

  constructor(pending: PendingTurns, send: (sessionKey: string, text: string, options: ReplyOptions) => Promise<unknown>) {
    this.pending = pending;
    this.send = send;
  }

  kick() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const heads = new Map<string, PendingReply>();
    for (const reply of this.pending.replies()) if (!reply.blocked && !heads.has(reply.sessionKey)) heads.set(reply.sessionKey, reply);
    let next = Infinity;
    for (const [key, reply] of heads) {
      if (this.halted.has(reply.id) || this.running.has(key)) continue;
      if (reply.nextAttemptAt <= Date.now()) {
        this.running.add(key);
        void this.deliver(reply);
      } else next = Math.min(next, reply.nextAttemptAt);
    }
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => this.kick(), Math.max(1, next - Date.now()));
      this.timer.unref();
    }
  }

  private async deliver(reply: PendingReply) {
    const { id, sessionKey: key, text, replyTo, sentChunks } = reply;
    try {
      await this.send(key, text, { replyTo, sentChunks, onChunk: (count) => this.pending.progress(id, count) });
      this.pending.acknowledge(id);
    } catch (error) {
      log.warn(`reply ${id} remains pending: ${error}`);
      try { this.pending.failed(id, String(error), error instanceof DeliveryBlocked); }
      catch (persistError) { this.halted.add(id); log.error(`could not record reply failure: ${persistError}`); }
    } finally {
      this.running.delete(key);
      // Keep retry bookkeeping off the completion call stack.
      if (!this.stopped) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.kick(), 1000);
        this.timer.unref();
      }
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

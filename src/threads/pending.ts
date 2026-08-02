import { PENDING_TURNS_FILE } from "../paths.ts";
import { readJsonFile, writeJsonFile } from "../util.ts";

export interface PendingTurn {
  threadId: string;
  /** Epoch ms the daemon last confirmed the turn was still running. How
   * recently it was interrupted is measured from here — measuring from the
   * turn's start would let a long turn outlive any reasonable wake window. */
  lastAliveAt: number;
}

/**
 * A durable ledger of turns that are mid-flight right now: written when a turn
 * starts, removed only after the channel had its chance to deliver the reply
 * (see Gateway.handle). Whatever survives a restart was interrupted — the
 * daemon was killed while the agent was still working or before the finished
 * reply reached the channel (most often because the agent restarted eleven
 * from inside its own turn). On startup the gateway drains this and re-wakes
 * the conversations that were cut off recently.
 *
 * Writes are synchronous (not debounced like the other stores): the whole point
 * is that the "begin" record outlives an immediate kill, so we cannot afford to
 * sit on it for even half a second.
 */
export class PendingTurns {
  private data: Record<string, PendingTurn>;
  private file: string;

  constructor(file = PENDING_TURNS_FILE) {
    this.file = file;
    this.data = readJsonFile(this.file, {});
  }

  begin(threadId: string, now = Date.now()) {
    this.data[threadId] = { threadId, lastAliveAt: now };
    writeJsonFile(this.file, this.data);
  }

  /** Re-stamp every in-flight turn as alive right now (periodic heartbeat). */
  beat(now = Date.now()) {
    const turns = Object.values(this.data);
    if (!turns.length) return;
    for (const turn of turns) turn.lastAliveAt = now;
    writeJsonFile(this.file, this.data);
  }

  end(threadId: string) {
    if (!this.data[threadId]) return;
    delete this.data[threadId];
    writeJsonFile(this.file, this.data);
  }

  /** Take and clear every recorded turn (consumed once, at startup). */
  drain(): PendingTurn[] {
    const turns = Object.values(this.data);
    if (turns.length) {
      this.data = {};
      writeJsonFile(this.file, this.data);
    }
    return turns;
  }
}

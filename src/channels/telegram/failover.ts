import { randomUUID } from "node:crypto";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { ModelEntry } from "../../config.ts";
import type { TurnFailure } from "../../agent/runner.ts";

/** Namespaces our own callback data, so a keyboard the agent built with the
 * telegram tool can never be mistaken for a failover offer. */
export const FAILOVER_PREFIX = "eleven:failover:";

/** How long the buttons stay live. Past it the conversation has moved on far
 * enough that replaying the turn is more surprising than useful. */
const OFFER_TTL_MS = 30 * 60 * 1000;
const MAX_OFFERS = 20;

/** `continue` picks the dead turn up where it stopped, keeping what its tools
 * already did; `restart` branches that attempt away and runs the original
 * request again from nothing. */
export type FailoverMode = "continue" | "restart";

export interface FailoverOffer<T> {
  /** Whatever the channel needs to run the turn again — never inspected here. */
  replay: T;
  /** The plan the retry runs: the next model leads, the rest stay its fallbacks. */
  models: ModelEntry[];
  /** How a restart discards the failed attempt; absent when it cannot be branched away. */
  rewind?: { from: string; to: string };
  sessionKey: string;
  at: number;
}

/**
 * What a `continue` retry is prompted with. Deliberately terse and static: the
 * request and the failed attempt's tool calls sit right above it in the
 * transcript, and the reason the model died says nothing the next one can use.
 */
export const CONTINUE_PROMPT =
  "[the attempt above was cut off mid-turn. Its tool calls already ran — don't repeat them. Pick it up from there and finish.]";

/** The provider prefix is noise on a button. */
export function modelName(ref: string): string {
  return ref.split("/").pop() || ref;
}

/**
 * Pending failover offers, one per failure message.
 *
 * The runner refuses to fail over on its own once an attempt ran tools, because
 * a rewind cannot undo what those tools did. That leaves a turn dead on a spent
 * quota with usable models still in the plan — so the two ways forward go into
 * the chat as buttons and the replay becomes the person's call.
 */
export class FailoverOffers<T> {
  private offers = new Map<string, FailoverOffer<T>>();

  /** Attach an offer to a conversation's failure, returning its keyboard. */
  offer(
    sessionKey: string,
    replay: T,
    failure: Pick<TurnFailure, "remaining" | "rewind">,
  ): InlineKeyboardMarkup | undefined {
    const next = failure.remaining[0];
    if (!next) return undefined;
    const id = randomUUID().slice(0, 8);
    this.offers.set(id, { replay, models: failure.remaining, rewind: failure.rewind, sessionKey, at: Date.now() });
    // Insertion-ordered: the oldest offer is the first to go.
    if (this.offers.size > MAX_OFFERS) this.offers.delete(this.offers.keys().next().value!);
    const on = modelName(next.model);
    return {
      inline_keyboard: [[
        { text: `▶ Continue on ${on}`, callback_data: `${FAILOVER_PREFIX}${id}:continue` },
        { text: `↻ Restart on ${on}`, callback_data: `${FAILOVER_PREFIX}${id}:restart` },
      ]],
    };
  }

  /**
   * Claim the offer behind a callback press. Consumed on the way out, so a
   * double press (or a redelivered update) can only run one retry — the two
   * buttons are two ways to answer the same failure, not two turns. The
   * conversation must match: a stale button must never fire a turn somewhere
   * it wasn't pressed.
   */
  take(callbackData: string, sessionKey: string, now = Date.now()): (FailoverOffer<T> & { mode: FailoverMode }) | undefined {
    if (!callbackData.startsWith(FAILOVER_PREFIX)) return undefined;
    const [id, mode] = callbackData.slice(FAILOVER_PREFIX.length).split(":");
    if (!id || (mode !== "continue" && mode !== "restart")) return undefined;
    const offer = this.offers.get(id);
    if (!offer) return undefined;
    this.offers.delete(id);
    if (offer.sessionKey !== sessionKey || now - offer.at > OFFER_TTL_MS) return undefined;
    return { ...offer, mode };
  }

  /** Retire a conversation's offers — a new turn ran, so its failed one is history. */
  clear(sessionKey: string): void {
    for (const [id, offer] of this.offers) {
      if (offer.sessionKey === sessionKey) this.offers.delete(id);
    }
  }
}

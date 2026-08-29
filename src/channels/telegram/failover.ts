import { randomUUID } from "node:crypto";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { ModelEntry } from "../../config.ts";
import type { TurnFailure } from "../../agent/runner.ts";

/** Namespaces our own callback data, so a keyboard the agent built with the
 * telegram tool can never be mistaken for a failover offer. */
export const FAILOVER_PREFIX = "eleven:failover:";

/** How long a retry button stays live. Past it the transcript has moved on far
 * enough that replaying the turn is more surprising than useful. */
const OFFER_TTL_MS = 30 * 60 * 1000;
const MAX_OFFERS = 20;

export interface FailoverOffer<T> {
  /** Where the failed turn ran — the retry lands in the same place. */
  target: T;
  /** The plan the retry runs: the next model leads, the rest stay its fallbacks. */
  models: ModelEntry[];
  failedModel: string;
  reason: string;
  sessionKey: string;
  at: number;
}

/** The provider prefix is noise on a button and in a prompt. */
export function modelName(ref: string): string {
  return ref.split("/").pop() || ref;
}

/**
 * Pending "retry on the next model" offers, one per failure message.
 *
 * The runner refuses to fail over on its own once an attempt ran tools, because
 * a rewind cannot undo what those tools did. That leaves a turn dead on a spent
 * quota with usable models still in the plan — so the offer is put in the chat
 * as a button and the replay becomes the person's call.
 */
export class FailoverOffers<T> {
  private offers = new Map<string, FailoverOffer<T>>();

  /** Attach an offer to a conversation's failure, returning its keyboard. */
  offer(sessionKey: string, target: T, failure: Pick<TurnFailure, "failedModel" | "remaining" | "message">): InlineKeyboardMarkup | undefined {
    const next = failure.remaining[0];
    if (!next) return undefined;
    const id = randomUUID().slice(0, 8);
    this.offers.set(id, {
      target,
      models: failure.remaining,
      failedModel: failure.failedModel,
      reason: failure.message,
      sessionKey,
      at: Date.now(),
    });
    // Insertion-ordered: the oldest offer is the first to go.
    if (this.offers.size > MAX_OFFERS) this.offers.delete(this.offers.keys().next().value!);
    return { inline_keyboard: [[{ text: `↻ Retry on ${modelName(next.model)}`, callback_data: `${FAILOVER_PREFIX}${id}` }]] };
  }

  /**
   * Claim the offer behind a callback press. Consumed on the way out, so a
   * double press (or a redelivered update) can only run the retry once. The
   * conversation must match: ids outlive nothing, but a stale button in another
   * chat must never fire a turn where it wasn't pressed.
   */
  take(callbackData: string, sessionKey: string, now = Date.now()): FailoverOffer<T> | undefined {
    if (!callbackData.startsWith(FAILOVER_PREFIX)) return undefined;
    const id = callbackData.slice(FAILOVER_PREFIX.length);
    const offer = this.offers.get(id);
    if (!offer) return undefined;
    this.offers.delete(id);
    if (offer.sessionKey !== sessionKey || now - offer.at > OFFER_TTL_MS) return undefined;
    return offer;
  }

  /** Retire a conversation's offers — a new turn ran, so its failed one is history. */
  clear(sessionKey: string): void {
    for (const [id, offer] of this.offers) {
      if (offer.sessionKey === sessionKey) this.offers.delete(id);
    }
  }
}

/**
 * What the retry turn is prompted with. The failed attempt's user message and
 * tool calls are already in the transcript, so the retry carries no copy of
 * either — it says what happened and hands the turn to the next model, the same
 * way a restart-wake picks a cut-off turn back up.
 */
export function retryPrompt(offer: FailoverOffer<unknown>): string {
  return (
    `[the turn above stopped on ${modelName(offer.failedModel)}: ${offer.reason}. ` +
    `The user asked eleven to retry it on ${modelName(offer.models[0]!.model)}. ` +
    "Whatever tool calls the failed attempt made already happened — do not repeat their side effects. " +
    "Pick the request up where it stopped and finish it.]"
  );
}

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ModelEntry } from "../config.ts";
import { TurnFailure, type TurnRewind } from "../agent/runner.ts";
import type { Gateway, IncomingMessage } from "../gateway.ts";
import type { logger } from "../log.ts";
import { summarizeToolArgs } from "../util.ts";
import { FailoverOffers, modelName, type ChatButton } from "./failover.ts";
import type { TurnStatus } from "./turn-status.ts";

/** Injected to resume a conversation whose turn a restart cut off (see gateway
 * interruptedTurns). The pending ledger releases only after the chat confirmed
 * the send, so waking implies the reply never landed: the model may have
 * written nothing, part of a reply, or a full one — it can see its own prior
 * output, and a finished answer must be (re)sent, not assumed delivered. */
export const WAKE_PROMPT =
  "[eleven restarted mid-turn. If you already finished a reply above, it likely never reached the user — send it again. Otherwise continue from wherever you left off. No need to mention the restart unless it changes your answer]";

/** A manual failover's own model plan for one turn, and the failed attempt a
 *  restart branches away first. */
export interface TurnRetry {
  models: ModelEntry[];
  rewind?: TurnRewind;
}

/**
 * How one turn's prose reaches the chat. Prose the runtime settles mid-loop goes
 * out while it is still true — it says what the model is about to do, and Claude
 * Code's loop can run for minutes before the turn ends. The answer goes out at
 * the end, inside the turn's durable window, minus whatever already left.
 *
 * `sent` is the conversation's, shared with the channel tool: whatever reached
 * the chat by any route is not sent twice.
 */
export function createTurnDelivery(
  send: (text: string, silent: boolean) => Promise<unknown>,
  sent: Set<string>,
  onError: (error: unknown) => void,
) {
  // One chain, so a slow send can't let the next chunk — or the answer —
  // overtake it. Sending prose early is worth nothing if the chat reorders it.
  let chain: Promise<unknown> = Promise.resolve();
  let flushed = false;
  /** Ship a block of prose now, unless the chat already has it. `silent` is for
   * prose that only says the turn is still working: it belongs in the chat, but
   * buzzing a phone for "checking X now" is a notification nobody asked for. */
  const early = (chunk: string, options: { silent?: boolean } = {}): void => {
    const text = chunk.trim();
    if (!text || sent.has(text)) return;
    // Remembering it here is also what keeps the final send from repeating it:
    // the turn's own text still carries this prose.
    sent.add(text);
    flushed = true;
    chain = chain.then(() => send(text, !!options.silent)).catch(onError);
  };
  const unsent = (blocks: string[]) => blocks.filter((block) => !sent.has(block)).join("\n\n");
  return {
    early,
    /** Ship, as one message, the blocks the chat doesn't have yet — what a
     * steered message cuts off. Joining first and checking after would miss the
     * prose already sent on its own and post it again glued to the answer. */
    catchUp(blocks: string[]): void {
      early(unsent(blocks));
    },
    /** What the chat is still owed once the early sends are out. */
    remaining(blocks: string[], resultText: string): string {
      return (flushed ? unsent(blocks) : resultText).trim();
    },
    /** Resolves when every early send has landed. */
    settled(): Promise<unknown> {
      return chain;
    },
  };
}

export interface ChatSendOptions {
  /** Deliver without a notification. */
  silent?: boolean;
  /** Thread the message onto the one that triggered the turn. */
  reply?: boolean;
  buttons?: ChatButton[][];
}

/** One turn in a chat, as a channel hands it over: the request, and how to
 * reach the chat it came from. */
export interface ChatTurn<R> {
  gateway: Gateway;
  sessionKey: string;
  text: string;
  images: ImageContent[];
  retry?: TurnRetry;
  /** What the gateway needs beyond the message itself. */
  incoming: Pick<IncomingMessage, "workspaceHint" | "modelScopes" | "appends" | "customTools" | "runtime">;
  /** Texts any route already delivered to this conversation — shared with the
   *  channel tool, cleared when the turn ends. */
  sent: Set<string>;
  status: TurnStatus;
  send(text: string, options: ChatSendOptions): Promise<unknown>;
  failovers: FailoverOffers<R>;
  /** What a failover button needs to run this turn again. */
  replay: R;
  /** Read at failure time: the setting may change while a turn runs. */
  autoFailover: () => boolean;
  log: ReturnType<typeof logger>;
}

/**
 * Run a chat turn end to end: stream prose out as the runtime settles it,
 * deliver the answer inside the turn's durable window, keep the status card
 * current, and settle a failure — with the failover buttons, or by handing back
 * the retry auto-failover decided on. The caller runs that retry as a turn of
 * its own, with its own status card: a retry must not share the dead turn's.
 */
export async function runChatTurn<R>(turn: ChatTurn<R>): Promise<{ models: ModelEntry[]; text: string } | undefined> {
  const { sessionKey, sent, status, log } = turn;
  // The conversation is moving on: a retry button left over from an earlier
  // failure would replay a turn this one has already gone past.
  turn.failovers.clear(sessionKey);

  const blocks: string[] = [];
  let current = "";
  const delivery = createTurnDelivery(
    (text, silent) => turn.send(text, { silent, reply: true }),
    sent,
    (error) => log.warn(`mid-turn flush failed: ${error}`),
  );
  // A turn that produces no event at all (a provider stalling on the first
  // request) still owes the chat a sign of life — a typing indicator expires
  // in seconds and says nothing about a turn that takes minutes.
  status.start();

  let autoRetry: { models: ModelEntry[]; text: string } | undefined;
  try {
    await turn.gateway.handle({
      ...turn.incoming,
      sessionKey,
      text: turn.text,
      images: turn.images,
      models: turn.retry?.models,
      rewind: turn.retry?.rewind,
      events: {
        onDelta: (delta) => {
          current += delta;
        },
        onAssistantText: () => {
          if (current.trim()) blocks.push(current.trim());
          current = "";
        },
        // What the model said before going back to work. It reads as an
        // intention ("checking X now"), so it is worth nothing once the work
        // it announces is already done — send it while it is still true, and
        // without a notification: the answer it precedes is what deserves one.
        onProse: (text) => delivery.early(text, { silent: true }),
        // The runtime answered what was asked first while what was asked
        // during the turn is still being written. Ship it now: the chat then
        // reads as the exchange it was, instead of both replies arriving
        // together with the older one underneath.
        onEarlyAnswer: (text) => delivery.early(text),
        // A steered message just entered the turn — deliver the prose that
        // preceded it now, so replies land in timeline order instead of a
        // stale answer arriving glued to the final one. This one is an answer,
        // not narration, so it notifies like any other.
        onEvent: (event) => {
          if (event.type !== "message_end" || event.message.role !== "user") return;
          delivery.catchUp(blocks.splice(0));
        },
        // Failover abandons the attempt's prose — drop our copy of it too.
        onFailover: () => {
          blocks.length = 0;
          current = "";
        },
        onPanels: (update) => status.panels(update),
        onToolCall: (name, args) => status.tool(name, summarizeToolArgs(args)),
        onRetry: (notice) => status.retry(notice),
      },
      // The final send runs inside the turn's durable window: the pending
      // ledger releases only after this settles, so a daemon death before the
      // chat confirms the send wakes the conversation instead of silently
      // losing the reply. A steered message never gets here — the owning
      // turn's deliver ships the combined result (and clears `sent`).
      deliver: async (result) => {
        await status.finish(result.status === "stopped" ? "stopped" : "completed");
        const final = delivery.remaining(blocks, result.text);
        const duplicate = !!final && sent.has(final);
        sent.clear(); // the turn is over — next one starts clean
        if (!final || duplicate) return;
        await delivery.settled(); // the answer never lands above the prose that led to it
        await turn.send(final, { reply: true });
      },
    });
  } catch (error) {
    sent.clear();
    await status.finish("failed");
    log.error(`turn failed: ${error}`);
    // The runner stops instead of failing over once an attempt ran tools (a
    // spent quota mid-turn is the common way there) — so when its plan still
    // has models left, the failure either carries the buttons that run the
    // next one, or runs it on its own when auto-failover is on.
    const next = error instanceof TurnFailure
      ? turn.failovers.resolve(sessionKey, turn.replay, error, turn.autoFailover())
      : undefined;
    autoRetry = next?.retry;
    const continuing = autoRetry ? ` — continuing on ${modelName(autoRetry.models[0]!)}` : "";
    // The failure is now a footnote to a turn that is still going: it still
    // belongs in the chat, but it doesn't deserve a notification of its own.
    await turn.send(`⚠️ ${error instanceof Error ? error.message : error}${continuing}`, {
      buttons: next?.buttons,
      silent: !!autoRetry,
    }).catch(() => {});
  } finally {
    status.cancel();
  }
  if (autoRetry) log.info(`auto failover in ${sessionKey}: continue on ${autoRetry.models[0]!.model}`);
  return autoRetry;
}

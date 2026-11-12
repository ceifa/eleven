import { estimateTokens, type AgentSession, type CompactionResult, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "../util.ts";
import { logger } from "../log.ts";
import { modelRef } from "./pi.ts";

const log = logger("runner");

/** Below this a model switch carries the conversation whole: re-reading it
 * uncached costs less than what cutting it would lose. */
const HANDOFF_MIN_TOKENS = 100_000;
const HANDOFF_REQUEST_CHARS = 4_000;

export interface Handoff {
  from: string;
  to: string;
}

/**
 * A model that takes over a long conversation has none of it cached, so every
 * request it makes re-reads all of it at full price — and a fallback tends to
 * take over exactly when a long task drained the model before it. Hand it the
 * recent part instead: a compaction that keeps Pi's recent window and replaces
 * the rest with a pointer to the transcript, written here rather than by a model
 * that would have to read everything to summarize it.
 */
export async function handOff(warm: { session: AgentSession; handoff: { current?: Handoff } }, model: Model<Api>): Promise<void> {
  const { session } = warm;
  const from = lastModelThatRan(session.agent.state.messages);
  const to = modelRef(model);
  if (!from || from === to) return;
  const tokens = session.getContextUsage()?.tokens ?? session.agent.state.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (tokens < HANDOFF_MIN_TOKENS) return;
  warm.handoff.current = { from, to };
  try {
    await session.compact();
    log.info(`handed ${to} the recent part of a ${tokens}-token conversation from ${from}`);
  } catch (error) {
    log.warn(`handoff from ${from} to ${to} kept the whole conversation: ${error}`);
  } finally {
    warm.handoff.current = undefined;
  }
}

/** The model behind the latest response that cost anything — operator-written
 * messages are recorded as assistant turns too, with no usage. */
function lastModelThatRan(messages: AgentMessage[]): string | undefined {
  const last = messages.findLast((message) => message.role === "assistant" && message.usage.totalTokens > 0);
  return last?.role === "assistant" ? `${last.provider}/${last.model}` : undefined;
}

/** The compaction a handoff writes: Pi's cut point, and in place of a summary,
 * where the rest is and the requests the cut would otherwise hide. */
export function handoffCompaction(
  preparation: SessionBeforeCompactEvent["preparation"],
  { from, to }: Handoff,
  sessionFile: string | undefined,
): CompactionResult {
  const firstRequest = preparation.messagesToSummarize.find((message) => message.role === "user");
  const currentRequest = preparation.isSplitTurn ? preparation.turnPrefixMessages.find((message) => message.role === "user") : undefined;
  const quote = (message: AgentMessage) => {
    const text = message.role === "user" ? contentText(message.content) : "";
    return text.length > HANDOFF_REQUEST_CHARS ? `${text.slice(0, HANDOFF_REQUEST_CHARS)}… [${text.length.toLocaleString("en-US")} characters]` : text;
  };
  const sections = [
    `This conversation moved from ${from} to ${to}, which has none of it cached, so only its most recent part follows.`
      + (sessionFile ? ` The full transcript is ${sessionFile} (a Pi session, one JSON entry per line): read what you need from it instead of guessing.` : ""),
    preparation.previousSummary && `Summary from an earlier compaction:\n${preparation.previousSummary}`,
    firstRequest && `The earliest request in the omitted part, verbatim:\n${quote(firstRequest)}`,
    currentRequest && `The request being worked on when the cut was made, verbatim:\n${quote(currentRequest)}`,
  ];
  return {
    summary: sections.filter(Boolean).join("\n\n"),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { handoff: { from, to } },
  };
}

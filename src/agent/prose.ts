import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { contentText } from "../util.ts";

/**
 * Folds one assistant message's stream into settled blocks of prose.
 *
 * A runtime that speaks more than once in a message — Claude Code, narrating
 * between its own tool calls — settles a block per text_end, and each is a unit
 * a channel can ship on its own instead of waiting for the turn to end. A
 * provider that streams nothing and only reports the text on message_end is
 * caught up by the tail below, measured against the whole message rather than
 * its last open block.
 */
export function createProseBlocks(onDelta: (delta: string) => void, onBlock: (block: string) => void) {
  let current = "";
  let settled: string[] = [];
  const endBlock = () => {
    const block = current;
    current = "";
    settled.push(block);
    onBlock(block);
  };
  return {
    startMessage() {
      current = "";
      settled = [];
    },
    delta(delta: string) {
      current += delta;
      onDelta(delta);
    },
    endBlock,
    /** `full` is the message's whole text as the provider finally reported it.
     * Returns the blocks this message settled, in order. */
    endMessage(full: string): string[] {
      // Once a block has settled, the message is already accounted for — and how
      // `full` joined those blocks is the reader's business, not a tail to
      // stream again. The catch-up is for a provider that streamed nothing.
      if (!settled.length && full.length > current.length) {
        const tail = full.slice(current.length);
        current += tail;
        onDelta(tail);
      }
      endBlock();
      return settled;
    },
  };
}

/**
 * The prose half of a session's event stream, folded into `prose`.
 *
 * A Pi-native model runs its tool loop as one assistant message per step, and
 * prose that settles in a message carrying tool calls is the model saying what
 * it is about to do — the same narration Claude Code's loop reports through its
 * prose listener. It goes to `onInterim` the moment its message ends: held to
 * the end of the turn it reaches the chat glued to the answer, minutes after it
 * was written, reading as if the work had not started yet.
 */
export function followProse(prose: ReturnType<typeof createProseBlocks>, onInterim: (text: string) => void) {
  return (event: AgentSessionEvent | AgentEvent) => {
    if (event.type === "message_start") {
      prose.startMessage();
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      prose.delta(event.assistantMessageEvent.delta);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      prose.endBlock();
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const blocks = prose.endMessage(contentText(message.content));
      if (!message.content.some((block) => block.type === "toolCall")) return;
      for (const block of blocks) if (block.trim()) onInterim(block.trim());
    }
  };
}

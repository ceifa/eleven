import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { contentText } from "../util.ts";

/* What goes into a Claude Code child: the input stream of a live turn, the
   prompt a turn opens with, and the ids that tie a Pi transcript to the hidden
   Claude session it resumes. */

/**
 * The SDK input stream of one live turn. It stays open for the whole turn (MCP
 * needs it), which also makes it the only way to hand Claude Code human input
 * mid-loop: Claude runs its entire tool loop inside a single Pi turn, so Pi's
 * own boundary injection would park a steered message until the loop ends —
 * minutes, in a real investigation.
 */
export class InputQueue {
  private readonly buffer: SDKUserMessage[] = [];
  private waiting: ((message: SDKUserMessage | undefined) => void) | undefined;
  private open = true;
  /** Uuids of the messages handed to the child that no result has answered yet,
   * in the order they were handed over. */
  private readonly unanswered = new Set<string>();

  /** The message this turn was created for; it answers the caller's own prompt. */
  seed(message: SDKUserMessage): void {
    this.unanswered.add(message.uuid!);
    this.buffer.push(message);
  }

  /**
   * Queue a human follow-up — as many as arrive while the turn runs. Claude
   * folds one that lands before a tool boundary into the running turn, and runs
   * one that lands after the last boundary as a turn of its own; either way the
   * result names the messages it answered (see settle), so input can stay open
   * for the next one. False once the turn is wrapping up: the caller falls back
   * to Pi's own steering.
   */
  push(message: SDKUserMessage): boolean {
    if (!this.open) return false;
    this.unanswered.add(message.uuid!);
    const resume = this.waiting;
    this.waiting = undefined;
    if (resume) resume(message);
    else this.buffer.push(message);
    return true;
  }

  /**
   * Cross off the messages one SDK result answered; true while another message
   * still waits for a result of its own. A result carries the uuid of every
   * message its turn consumed, the ones folded in mid-loop included. One that
   * carries none (an older CLI) answers the oldest message still waiting.
   */
  settle(result: { user_message_uuid?: string; user_message_uuids?: string[] }): boolean {
    const answered = result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : []);
    if (answered.length) for (const uuid of answered) this.unanswered.delete(uuid);
    else for (const uuid of this.unanswered) { this.unanswered.delete(uuid); break; }
    return this.unanswered.size > 0;
  }

  /** Stop accepting input without ending the stream (the turn is wrapping up). */
  seal(): void {
    this.open = false;
  }

  close(): void {
    this.seal();
    this.waiting?.(undefined);
    this.waiting = undefined;
  }

  async *drain(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const queued = this.buffer.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (!this.open) return;
      const next = await new Promise<SDKUserMessage | undefined>((resolve) => (this.waiting = resolve));
      if (!next) return;
      yield next;
    }
  }
}

/** A deterministic UUID for one transactional Claude attempt. Each successful
 * Pi transcript prefix maps to one resumable Claude fork, so daemon restarts do
 * not need a second mapping store. */
export function claudeAttemptId(piSessionId: string, modelId: string, messages: Context["messages"]): string {
  const hash = createHash("sha256")
    .update("eleven/claude-code/session/v1\0")
    .update(piSessionId)
    .update("\0")
    .update(modelId)
    .update("\0")
    .update(claudeInputHash(messages))
    .digest("hex");
  // Agent SDK session ids are UUIDs. Stamp RFC 4122 version/variant bits into
  // the stable digest instead of keeping a separate random-id mapping.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${["8", "9", "a", "b"][parseInt(hash[16], 16) % 4]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function claudeInputHash(messages: Context["messages"]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(messageFingerprint))).digest("hex");
}

/** The content blocks of the turn's own prompt: the pending user input, plus a
 * transcript of everything that happened in another runtime before it.
 *
 * `delivered` is input this child already took mid-turn, which reaches the
 * context afterwards looking exactly like new input. A bootstrapping child took
 * nothing, so it is only ever consulted for a resume. */
export function promptBlocks(
  messages: Context["messages"],
  currentStart: number,
  bootstrap: boolean,
  delivered: string[] = [],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (bootstrap && currentStart > 0) {
    blocks.push({
      type: "text",
      text: `The conversation before this turn happened in another runtime. Continue it faithfully from this transcript:\n\n${formatTranscript(messages.slice(0, currentStart))}`,
    });
  }
  for (const message of messages.slice(currentStart)) {
    if (message.role !== "user") continue; // failed-attempt assistant envelopes are not new human input
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    // One entry answers for one message: the same text typed twice is two
    // messages, and the second one is still waiting for an answer.
    const alreadyDelivered = delivered.indexOf(contentText(content));
    if (alreadyDelivered !== -1) {
      delivered.splice(alreadyDelivered, 1);
      continue;
    }
    blocks.push(...userBlocks(content));
  }
  return blocks;
}

export function userBlocks(content: string | (TextContent | ImageContent)[], images?: ImageContent[]): Array<Record<string, unknown>> {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }, ...(images ?? [])] : content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of parts) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    if (block.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    }
  }
  return blocks;
}

export function humanMessage(blocks: Array<Record<string, unknown>>): SDKUserMessage {
  return {
    type: "user",
    // The key each result names its answered messages by (InputQueue.settle).
    uuid: randomUUID(),
    message: { role: "user", content: blocks as never },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

function formatTranscript(messages: Context["messages"]): string {
  return messages.map((message) => {
    const extended = message as unknown as { role: string; summary?: string; content?: unknown };
    if (extended.role === "compactionSummary") return `Conversation summary: ${extended.summary ?? "[unavailable]"}`;
    if (message.role === "toolResult") return `Tool result (${message.toolName}): ${contentText(message.content)}`;
    const label = message.role === "assistant" ? "Assistant" : "User";
    const text = contentText(message.content);
    const toolCalls = message.role === "assistant"
      ? message.content.filter((block) => block.type === "toolCall").map((block) => `[called ${block.name} ${JSON.stringify(block.arguments)}]`).join("\n")
      : "";
    return `${label}: ${[text, toolCalls].filter(Boolean).join("\n") || "[non-text content]"}`;
  }).join("\n\n");
}

export function trailingUserStart(messages: Context["messages"]): number {
  let index = messages.length;
  while (index > 0 && messages[index - 1].role === "user") index--;
  return index;
}

function messageFingerprint(message: Context["messages"][number]): unknown {
  const extended = message as unknown as { role: string; summary?: string };
  if (extended.role === "compactionSummary") return { role: extended.role, summary: extended.summary };
  if (message.role === "assistant") {
    return { role: message.role, provider: message.provider, model: message.model, content: message.content };
  }
  if (message.role === "toolResult") {
    return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError };
  }
  return { role: message.role, content: message.content };
}

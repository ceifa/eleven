import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "../util.ts";
import { CLAUDE_CODE_PROVIDER } from "./claude-code.ts";

/* What the model is shown each request, where it differs from Pi's own
   snapshot: input and tool history that reached the runtime without passing
   through Pi, put back where it happened, and old runtime output cut to size. */

/** Native history and directly delivered input bypass Pi's running snapshot.
 * Drain them into its next turn before preparation, so compaction sees them
 * without having the original messages reinserted after its summary. */
export function keepRuntimeInputsInContext(session: AgentSession, takeInputs: () => AgentMessage[]): void {
  const { agent } = session;
  const previous = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const messages = withRuntimeInputs(turn.context.messages, takeInputs());
    if (messages === turn.context.messages) return previous?.(turn, signal);
    const context = { ...turn.context, messages };
    const snapshot = await previous?.({ ...turn, context }, signal);
    return { ...snapshot, context: snapshot?.context ?? context };
  };
}

/**
 * A live turn's context with the input and tool history Pi's snapshot missed put back
 * where it happened: before the answer that was being written when it arrived,
 * which is where the durable transcript records it too. Messages already in the
 * context are left alone — the loop carries the array forward from one turn to
 * the next, so this runs again on its own output, and a compaction mid-turn
 * hands back the same message reloaded from the transcript as a new object.
 * Returns the original array when there is nothing to add, so pi's snapshot is
 * passed through untouched.
 */
export function withRuntimeInputs(messages: AgentMessage[], injected: AgentMessage[]): AgentMessage[] {
  const present = new Set(messages.map(runtimeInputKey));
  const missing = injected.filter((message) => !present.has(runtimeInputKey(message)));
  if (!missing.length) return messages;
  // Never between an assistant's tool calls and their results: when the turn
  // used tools, those results are the tail and the input goes after them.
  const cut = messages.length - (messages.at(-1)?.role === "assistant" ? 1 : 0);
  return [...messages.slice(0, cut), ...missing, ...messages.slice(cut)];
}

/** A message steered during a native call is recorded immediately; its result
 * must still precede that input in the model's tool protocol. */
export function withToolResults(messages: AgentMessage[]): AgentMessage[] {
  const results = new Map(messages.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
  const moved = new Set<AgentMessage>();
  const ordered: AgentMessage[] = [];
  for (const message of messages) {
    if (moved.has(message)) continue;
    ordered.push(message);
    if (message.role === "toolResult") results.delete(message.toolCallId);
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      if (!result) continue;
      ordered.push(result);
      moved.add(result);
      results.delete(block.id);
    }
  }
  return ordered.every((message, index) => message === messages[index]) ? messages : ordered;
}

const RESULT_HEAD_CHARS = 2_000;
const RESULTS_BUDGET_CHARS = 60_000;
const ANSWERED_ARGUMENT_CHARS = 300;

/** Claude Code's tool history never entered Pi's context before, and a real
 * thread's runs past a million tokens. A provider picking such a thread up gets
 * every call with short arguments and the head of the newest outputs, up to a
 * fixed budget — not all of it cold. Turns still unanswered keep everything a
 * continuation needs. */
export function boundRuntimeResults(messages: AgentMessage[]): AgentMessage[] {
  const answered = messages.findLastIndex((message) => message.role === "assistant" && message.stopReason === "stop");
  const runtimeCalls = new Set(messages.slice(0, answered).flatMap((message) =>
    message.role === "assistant" && message.provider === CLAUDE_CODE_PROVIDER
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : []));
  if (!runtimeCalls.size) return messages;
  // Newest first, and once one does not fit nothing older does: the window stays contiguous.
  const kept = new Set<number>();
  let budget = RESULTS_BUDGET_CHARS;
  for (let index = answered - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult" || !runtimeCalls.has(message.toolCallId)) continue;
    const size = Math.min(contentText(message.content).length, RESULT_HEAD_CHARS);
    if (size > budget) break;
    budget -= size;
    kept.add(index);
  }
  return messages.map((message, index) => {
    if (index > answered) return message;
    if (message.role === "assistant") {
      if (message.provider !== CLAUDE_CODE_PROVIDER) return message;
      const content = message.content.map((block) => block.type === "toolCall" ? { ...block, arguments: shortenStrings(block.arguments) as JsonObject } : block);
      return JSON.stringify(content) === JSON.stringify(message.content) ? message : { ...message, content };
    }
    if (message.role !== "toolResult" || !runtimeCalls.has(message.toolCallId)) return message;
    const text = contentText(message.content);
    const images = message.content.some((block) => block.type === "image");
    if (!kept.has(index)) {
      return { ...message, content: [{ type: "text", text: `[older output omitted for context (${text.length.toLocaleString("en-US")} characters). Run the tool again if you need it.]` }] };
    }
    if (text.length <= RESULT_HEAD_CHARS && !images) return message;
    const shown = Math.min(text.length, RESULT_HEAD_CHARS).toLocaleString("en-US");
    const notice = `[output shortened for context: ${shown} of ${text.length.toLocaleString("en-US")} characters${images ? ", images omitted" : ""}. Run the tool again if you need the rest.]`;
    return { ...message, content: [{ type: "text", text: `${text.slice(0, RESULT_HEAD_CHARS)}\n${notice}` }] };
  });
}

function shortenStrings(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.length > ANSWERED_ARGUMENT_CHARS ? `${value.slice(0, ANSWERED_ARGUMENT_CHARS)}… [${value.length.toLocaleString("en-US")} characters]` : value;
  }
  if (Array.isArray(value)) return value.map(shortenStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenStrings(item)]));
  return value;
}

/** Identifies one message across a transcript round-trip: the arrival instant
 * plus what was said. Two messages of the same turn never share both. */
function runtimeInputKey(message: AgentMessage): string {
  const timestamp = (message as { timestamp?: number }).timestamp ?? 0;
  const callId = message.role === "toolResult" ? message.toolCallId : "";
  return `${message.role}\0${timestamp}\0${callId}\0${JSON.stringify((message as { content?: unknown }).content)}`;
}

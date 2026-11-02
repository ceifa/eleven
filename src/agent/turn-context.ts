import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const DATE_CONTEXT_TYPE = "eleven:date";

/** Append a date update rather than changing the conversation's cached prefix. */
export function dateContextMessage(messages: AgentMessage[]) {
  const timeZone = process.env.TZ ?? "America/Sao_Paulo";
  const today = new Date().toLocaleDateString("en-US", { dateStyle: "full", timeZone });
  const content = `Today: ${today} (${timeZone})`;
  const previous = messages.findLast((message) => message.role === "custom" && message.customType === DATE_CONTEXT_TYPE);
  if (previous?.role === "custom" && previous.content === content) return undefined;
  return { customType: DATE_CONTEXT_TYPE, content, display: false };
}

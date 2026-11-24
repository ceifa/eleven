import {
  ComponentType,
  InteractionResponseType,
  TextInputStyle,
  type APIInteractionResponse,
  type APIModalSubmission,
} from "discord-api-types/v10";
import { clampMinutes, SECRET_NAME } from "../../secrets.ts";
import type { ButtonSpec } from "./send.ts";

// A press opens a form instead of starting a turn: what is typed there reaches
// the bot as an interaction, never as a message in the channel's history.
export const SECRET_PREFIX = "eleven-secret:";
const VALUE_ID = "value";

export interface SecretAsk {
  name: string;
  minutes: number;
}

export function secretButton(ask: SecretAsk): ButtonSpec {
  return { label: `🔑 Send ${ask.name}`, data: `${SECRET_PREFIX}${ask.name}:${clampMinutes(ask.minutes)}` };
}

export function parseSecretId(customId: string): SecretAsk | undefined {
  if (!customId.startsWith(SECRET_PREFIX)) return undefined;
  const [name, minutes] = customId.slice(SECRET_PREFIX.length).split(":");
  if (!SECRET_NAME.test(name ?? "")) return undefined;
  return { name, minutes: clampMinutes(Number(minutes)) };
}

export function secretModal(customId: string, ask: SecretAsk): APIInteractionResponse {
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: customId,
      title: "Secret for the agent",
      components: [{
        type: ComponentType.Label,
        label: ask.name.slice(0, 45),
        description: `Kept in memory for ${ask.minutes} min, never in the chat. The field is not masked while you type.`,
        component: { type: ComponentType.TextInput, custom_id: VALUE_ID, style: TextInputStyle.Paragraph, required: true, max_length: 4000 },
      }],
    },
  };
}

/** The typed value, whether Discord wraps the input in a label or (older clients) an action row. */
export function submittedValue(data: APIModalSubmission): string | undefined {
  const stack: unknown[] = [...data.components];
  while (stack.length) {
    const node = stack.pop() as { custom_id?: string; value?: string; component?: unknown; components?: unknown[] } | undefined;
    if (!node) continue;
    if (node.custom_id === VALUE_ID && typeof node.value === "string") return node.value.trim() || undefined;
    if (node.component) stack.push(node.component);
    if (node.components) stack.push(...node.components);
  }
  return undefined;
}

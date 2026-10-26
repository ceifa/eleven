import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIMessage,
  type APIMessageTopLevelComponent,
} from "discord-api-types/v10";
import { discordChunks } from "./markdown.ts";
import type { DiscordRest, Upload } from "./rest.ts";

/** A button the agent offers: a link, or data sent back when pressed. */
export interface ButtonSpec {
  label: string;
  url?: string;
  data?: string;
}

export interface DiscordSendOptions {
  /** The message this one answers; the first chunk replies to it. */
  replyTo?: string;
  /** Rows of buttons, hung under the last chunk. */
  buttons?: ButtonSpec[][];
  /** Deliver without a push notification (Discord's @silent). */
  silent?: boolean;
  /** Files uploaded with the first chunk. */
  files?: Upload[];
}

// Discord's component limits: five rows of five buttons, an 80-character label,
// and 100 characters of custom_id.
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_LABEL = 80;
const MAX_CUSTOM_ID = 100;

/**
 * Send agent markdown as one or more Discord messages. Link previews are
 * suppressed: an agent's answer is full of URLs, and a card under each one
 * buries the text it belongs to. Mentions are limited to people, so an agent
 * quoting "@everyone" pings no one.
 */
export async function sendMessage(rest: DiscordRest, channelId: string, markdown: string, options: DiscordSendOptions = {}): Promise<APIMessage | undefined> {
  const chunks = discordChunks(markdown);
  if (!chunks.length) {
    if (!options.files?.length) return undefined;
    chunks.push("");
  }
  let last: APIMessage | undefined;
  for (const [index, content] of chunks.entries()) {
    const first = index === 0;
    last = await rest.request<APIMessage>("POST", `/channels/${channelId}/messages`, {
      creates: true,
      files: first ? options.files : undefined,
      body: {
        content,
        flags: MessageFlags.SuppressEmbeds | (options.silent ? MessageFlags.SuppressNotifications : 0),
        // A reply pings its author unless told otherwise — exactly the
        // notification a silent message must not make.
        allowed_mentions: { parse: ["users"], replied_user: !options.silent },
        message_reference: first && options.replyTo ? { message_id: options.replyTo, fail_if_not_exists: false } : undefined,
        components: index === chunks.length - 1 ? components(options.buttons) : undefined,
      },
    });
  }
  return last;
}

/** Buttons as Discord action rows. */
export function components(rows?: ButtonSpec[][]): APIActionRowComponent<APIButtonComponent>[] | undefined {
  const kept = rows?.filter((row) => row.length).slice(0, MAX_ROWS);
  if (!kept?.length) return undefined;
  return kept.map((row) => ({
    type: ComponentType.ActionRow,
    components: row.slice(0, MAX_BUTTONS_PER_ROW).map((button): APIButtonComponent => {
      const label = button.label.slice(0, MAX_LABEL);
      return button.url
        ? { type: ComponentType.Button, style: ButtonStyle.Link, label, url: button.url }
        : { type: ComponentType.Button, style: ButtonStyle.Secondary, label, custom_id: (button.data ?? button.label).slice(0, MAX_CUSTOM_ID) };
    }),
  }));
}

/**
 * The same rows after a press: every action greyed out, with a tick on the one
 * that was taken. Links stay usable — they are not actions, and stay useful
 * after the fact.
 */
export function disableComponents(rows: APIMessageTopLevelComponent[] | undefined, pressed: string): APIMessageTopLevelComponent[] {
  return (rows ?? []).map((row) => {
    if (row.type !== ComponentType.ActionRow) return row;
    return {
      ...row,
      components: row.components.map((component) => {
        if (component.type !== ComponentType.Button || component.style === ButtonStyle.Link || component.style === ButtonStyle.Premium) return component;
        const taken = component.custom_id === pressed;
        return { ...component, disabled: true, style: taken ? ButtonStyle.Primary : component.style, label: taken ? `✓ ${component.label ?? ""}`.trim() : component.label };
      }),
    } as APIMessageTopLevelComponent;
  });
}

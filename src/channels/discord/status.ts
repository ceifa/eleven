import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type APIMessage,
  type APIMessageTopLevelComponent,
  type APIContainerComponent,
} from "discord-api-types/v10";
import { compact, ELAPSED_MIN_MS, formatDuration, renderPanel, RUN_ICONS, TurnStatus, type StatusView, type TurnOutcome } from "../turn-status.ts";
import { escapeMarkdown } from "./markdown.ts";
import { isNoop, type DiscordRest } from "./rest.ts";

/** Pressing it is `/stop` for the conversation the card belongs to. */
export const STOP_BUTTON_ID = "eleven:stop";

// Discord allows about five writes per five seconds in a channel.
const THROTTLE_MS = 1_200;
// A typing indicator lasts ten seconds; renew it before it lapses.
const TYPING_RENEW_MS = 8_000;
// The text a Components V2 message may carry, across all its parts.
const MAX_TEXT = 4_000;

const ACCENT: Record<TurnOutcome | "running" | "retrying", number> = {
  running: 0x5865f2,
  retrying: 0xfee75c,
  completed: 0x57f287,
  failed: 0xed4245,
  stopped: 0x99aab5,
};

const HEADLINE: Record<TurnOutcome | "running", string> = {
  running: "⚙️ **Working**",
  completed: "✅ **Done**",
  failed: "❌ **Ended with an error**",
  stopped: "⏹ **Stopped**",
};

export interface DiscordCard {
  components: APIMessageTopLevelComponent[];
}

const PANEL_STYLE = { title: (title: string) => `**${escapeMarkdown(title)}**`, text: escapeMarkdown };

// Discord's own limits: five buttons to a row, five rows to a message.
const BUTTONS_PER_ROW = 5;
const MAX_BUTTON_ROWS = 5;

/**
 * A turn's status as a Components V2 card: a container whose accent says how
 * the turn is going, the headline with what it is doing in small print, each
 * panel under a divider, then each background run the turn started with its
 * own headline and panels — and a Stop button for the turn while it runs and
 * for each run while that runs.
 */
export function renderDiscordCard(view: StatusView): DiscordCard | undefined {
  const { panels, outcome, running, retry } = view;
  const runs = view.runs ?? [];
  if (!panels.length && !outcome && !running && !retry && !runs.length) return undefined;
  const live = runs.filter((run) => !run.outcome);
  const details: string[] = [];
  if (running && running.elapsedMs >= ELAPSED_MIN_MS) details.push(formatDuration(running.elapsedMs));
  if (running?.tool) details.push(`🔧 ${escapeMarkdown(running.tool.name)}${running.tool.summary ? ` · ${escapeMarkdown(compact(running.tool.summary, 80))}` : ""}`);
  const lines = [HEADLINE[outcome ?? "running"]];
  if (details.length) lines.push(`-# ${details.join(" · ")}`);
  if (retry) lines.push(`-# 🔁 Retry ${retry.attempt}/${retry.maxAttempts} · ${escapeMarkdown(compact(retry.errorMessage, 90))}`);

  const header = lines.join("\n");
  const body: APIContainerComponent["components"] = [{ type: ComponentType.TextDisplay, content: header }];
  const sections = [
    ...panels.map((panel) => renderPanel(panel, PANEL_STYLE)),
    ...runs.flatMap((run) => [
      `${RUN_ICONS[run.outcome ?? "running"]} **${escapeMarkdown(compact(run.title))}** · ${run.outcome ?? "running"}\n-# ${formatDuration(run.elapsedMs)}`,
      ...run.panels.map((panel) => renderPanel(panel, PANEL_STYLE)),
    ]),
  ];
  let budget = MAX_TEXT - header.length;
  for (const [index, content] of sections.entries()) {
    if (content.length > budget) {
      body.push({ type: ComponentType.TextDisplay, content: `-# … ${sections.length - index} more` });
      break;
    }
    budget -= content.length;
    body.push({ type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small });
    body.push({ type: ComponentType.TextDisplay, content });
  }

  const components: APIMessageTopLevelComponent[] = [{
    type: ComponentType.Container,
    // A finished turn whose runs still work is still a card in motion.
    accent_color: ACCENT[outcome && !live.length ? outcome : retry ? "retrying" : "running"],
    components: body,
  }];
  const buttons = [
    ...(outcome ? [] : [{ label: "Stop", custom_id: STOP_BUTTON_ID }]),
    ...live.map((run) => ({ label: `Stop ${compact(run.title, 70)}`, custom_id: run.stopId })),
  ].map((button) => ({ type: ComponentType.Button as const, style: ButtonStyle.Secondary as const, emoji: { name: "⏹" }, ...button }));
  for (let i = 0; i < buttons.length && i < BUTTONS_PER_ROW * MAX_BUTTON_ROWS; i += BUTTONS_PER_ROW) {
    components.push({ type: ComponentType.ActionRow, components: buttons.slice(i, i + BUTTONS_PER_ROW) });
  }
  return { components };
}

/** The turn's status card in a Discord channel, with the client's own "is
 *  typing…" kept on for as long as the turn runs. */
export class DiscordTurnStatus extends TurnStatus<DiscordCard> {
  private typing: NodeJS.Timeout | undefined;
  private rest: DiscordRest;
  private channelId: string;

  constructor(rest: DiscordRest, channelId: string, replyTo?: string) {
    let messageId: string | undefined;
    const tolerate = (error: unknown) => {
      if (!isNoop(error)) throw error;
    };
    super({
      post: async (card) => {
        const message = await rest.request<APIMessage>("POST", `/channels/${channelId}/messages`, {
          creates: true,
          body: {
            ...card,
            flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
            allowed_mentions: { parse: [] },
            message_reference: replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined,
          },
        });
        messageId = message.id;
      },
      edit: (card) => rest.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { body: { ...card, flags: MessageFlags.IsComponentsV2 } }).then(() => {}, tolerate),
      remove: () => rest.request("DELETE", `/channels/${channelId}/messages/${messageId}`).then(() => {}, tolerate),
    }, { render: renderDiscordCard, throttleMs: THROTTLE_MS, rateKey: `discord:${channelId}` });
    this.rest = rest;
    this.channelId = channelId;
  }

  override start(): void {
    super.start();
    const type = () => void this.rest.request("POST", `/channels/${this.channelId}/typing`).catch(() => {});
    type();
    this.typing = setInterval(type, TYPING_RENEW_MS);
    this.typing.unref();
  }

  // The answer follows finish(): typing must be off before it lands, or the
  // indicator outlives the turn by up to ten seconds.
  override finish(outcome: TurnOutcome): Promise<void> {
    this.stopTyping();
    return super.finish(outcome);
  }

  override cancel(): void {
    this.stopTyping();
    super.cancel();
  }

  private stopTyping(): void {
    clearInterval(this.typing);
    this.typing = undefined;
  }
}

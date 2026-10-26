import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isNoop, type DiscordRest } from "./rest.ts";
import { sendMessage } from "./send.ts";

// Discord takes ten files per message.
const MAX_FILES = 10;

const threadParameters = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100, description: "Short title for the separate conversation" }),
  message: Type.String({ minLength: 1, description: "Self-contained task and context; the parent's history is NOT copied" }),
  start: Type.Optional(Type.Boolean({ description: "Start an independent agent turn immediately (default false)" })),
  persistent: Type.Optional(Type.Boolean({ description: "Keep this conversation's agent context across idle periods until explicitly archived (default false)" })),
});
export type DiscordThreadRequest = Static<typeof threadParameters>;

const parameters = Type.Object({
  action: Type.Union([Type.Literal("send"), Type.Literal("react"), Type.Literal("delete"), Type.Literal("thread")], {
    description: "send a message/files, react, delete your message, or open a separate thread",
  }),
  thread: Type.Optional(threadParameters),
  text: Type.Optional(Type.String({ description: "Markdown text (send). Sent in the same message as the files, when files are given." })),
  media: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Absolute path of a local file to send, or several paths (up to 10) to send them together",
    }),
  ),
  buttons: Type.Optional(
    Type.Array(
      Type.Array(
        Type.Object({
          label: Type.String(),
          url: Type.Optional(Type.String()),
          data: Type.Optional(Type.String({ description: "custom data (≤100 chars); sent back to you as text when pressed" })),
        }),
      ),
      { description: "Button rows (max 5 rows of 5)" },
    ),
  ),
  messageId: Type.Optional(Type.String({ description: "Target message id (react/delete)" })),
  emoji: Type.Optional(Type.String({ description: "Reaction emoji (react): a unicode emoji, or name:id for a custom one" })),
  silent: Type.Optional(Type.Boolean({ description: "Send without a notification" })),
});

/**
 * The channel tool a Discord-routed agent gets: proactive sends, files,
 * buttons, reactions. Plain prose replies don't need it — they are delivered
 * automatically. `onSent` reports sent text so the caller can avoid delivering
 * the same content twice.
 */
export function discordTool(
  rest: DiscordRest,
  channelId: string,
  onSent?: (text: string) => void,
  createThread?: (request: DiscordThreadRequest) => Promise<string>,
): ToolDefinition {
  return defineTool({
    name: "discord",
    label: "Discord",
    description:
      "Interact with the current Discord conversation beyond your normal reply: send extra messages, " +
      "files, buttons, reactions, delete your message, or create a thread with its own context. " +
      "Use action=thread with thread={name,message,start?}; start=true delegates work in parallel without waiting for the answer. " +
      "From a public thread, this creates a sibling under its parent channel. Not available in DMs or private threads. Your final answer is delivered " +
      "automatically — do NOT repeat content you already sent with this tool.",
    parameters,
    async execute(_id, params) {
      const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
      try {
        switch (params.action) {
          case "thread": {
            if (!params.thread?.name.trim() || !params.thread.message.trim()) return ok("thread needs a name and an opening message");
            if (!createThread) return ok("thread creation is unavailable in this conversation");
            return ok(await createThread(params.thread));
          }
          case "send": {
            const paths = typeof params.media === "string" ? [params.media] : (params.media ?? []);
            if (paths.length > MAX_FILES) return ok(`too many files: Discord takes ${MAX_FILES} per message`);
            if (!params.text && !paths.length) return ok("nothing to send: provide text or media");
            const message = await sendMessage(rest, channelId, params.text ?? "", {
              files: paths.map((path) => ({ path })),
              buttons: params.buttons,
              silent: params.silent,
            });
            // Record only after a successful send, so a failed send doesn't make
            // the caller suppress the model's final answer as a "duplicate".
            if (params.text) onSent?.(params.text.trim());
            return ok(`sent (message_id ${message?.id})`);
          }
          case "react": {
            if (!params.messageId || !params.emoji) return ok("react needs messageId and emoji");
            await rest.request("PUT", `/channels/${channelId}/messages/${params.messageId}/reactions/${encodeURIComponent(params.emoji)}/@me`);
            return ok("reacted");
          }
          case "delete": {
            if (!params.messageId) return ok("delete needs messageId");
            await rest.request("DELETE", `/channels/${channelId}/messages/${params.messageId}`);
            return ok("deleted");
          }
        }
      } catch (error) {
        if (isNoop(error)) return ok("already done");
        return ok(`discord error: ${error}`);
      }
    },
  });
}

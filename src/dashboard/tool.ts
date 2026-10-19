import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const parameters = Type.Object({
  text: Type.String({ description: "Markdown text shown above the buttons" }),
  buttons: Type.Array(
    Type.Array(
      Type.Object({
        label: Type.String(),
        url: Type.Optional(Type.String()),
        data: Type.Optional(Type.String({ description: "sent back to you as text when pressed (defaults to the label)" })),
      }),
    ),
    { description: "Button rows" },
  ),
});

/**
 * The channel tool a dashboard turn gets: a message with buttons to click. The
 * call itself is the message — its args are persisted in the transcript, and
 * the page draws them — so there is nothing to send and no per-conversation
 * state. One instance for every thread keeps the runner's warm-session reuse,
 * which needs the same tool objects across turns.
 */
export const dashboardTool = defineTool({
  name: "dashboard",
  label: "Dashboard",
  description:
    "Show the person a message with buttons to click in the eleven web dashboard. A press arrives " +
    "as your next message. Your final answer is shown automatically — do NOT repeat this text in it.",
  parameters,
  async execute() {
    return { content: [{ type: "text" as const, text: "shown" }], details: undefined };
  },
});

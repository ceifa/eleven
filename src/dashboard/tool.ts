import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-coding-agent";

// Extra arguments a model adds are ignored, not refused.
const OPEN = { open: true };

const parameters = obj({
  text: str({ description: "Markdown text shown above the buttons" }),
  buttons: arr(
    arr(
      obj({
        label: str(),
        url: opt(str()),
        data: opt(str({ description: "sent back to you as text when pressed (defaults to the label)" })),
      }, OPEN),
    ),
    { description: "Button rows" },
  ),
}, OPEN);

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

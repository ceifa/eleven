import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api } from "grammy";
import { PanelBoard, readToolPanels, type PanelUpdate } from "../src/agent/panels.ts";
import { TelegramTurnStatus } from "../src/channels/telegram/turn-status.ts";

const wrap = (panels: unknown) => ({ content: [{ type: "text", text: "working" }], details: { panels } });
const panel = (title: string, ...texts: string[]) => ({ title, rows: texts.map((text) => ({ text, state: "active" as const })) });

describe("readToolPanels", () => {
  test("reads the panels a tool attached, under the call's scope", () => {
    const update = readToolPanels(
      wrap([{ title: "Phases", icon: "📋", rows: [{ text: "scout", state: "done", note: "3s", detail: [["tokens", "900"]] }], more: 4 }]),
      "call-7",
      "workflow",
    );
    deepStrictEqual(update, {
      scope: "call-7",
      tool: "workflow",
      panels: [{ title: "Phases", icon: "📋", rows: [{ text: "scout", state: "done", note: "3s", detail: [["tokens", "900"]] }], more: 4 }],
    });
  });

  test("drops malformed rows instead of throwing", () => {
    // The payload crosses a tool boundary (and MCP's transport): nothing about
    // its shape is guaranteed, and a bad report must never fail the tool call.
    const update = readToolPanels(
      wrap([{ rows: [{ text: "kept", detail: [["a", "b"], ["only one"], "junk"] }, { state: "done" }, null, "junk"] }, "junk", { title: "no rows" }]),
      "s",
      "tool",
    );
    // An untitled panel takes the tool's name; a row without a state is one
    // somebody is working on.
    deepStrictEqual(update?.panels, [{ title: "tool", rows: [{ text: "kept", state: "active", detail: [["a", "b"]] }] }]);
  });

  test("anything but a panel list is no report at all", () => {
    for (const value of [undefined, null, "text", 7, {}, { details: {} }, { details: { panels: "nope" } }]) {
      strictEqual(readToolPanels(value, "s", "tool"), undefined);
    }
  });

  test("an empty list is how a tool clears what it showed", () => {
    deepStrictEqual(readToolPanels(wrap([]), "s", "tool"), { scope: "s", tool: "tool", panels: [] });
  });
});

describe("PanelBoard", () => {
  test("a producer's update replaces its own panels and nobody else's", () => {
    // Regression: snapshots used to clear the whole board, so the first tool to
    // report its phases erased the plan from the status message.
    const board = new PanelBoard();
    board.apply({ scope: "tasks", panels: [panel("Plan", "session task")] });
    board.apply({ scope: "call-7", panels: [panel("Phases", "first phase")] });
    board.apply({ scope: "call-7", panels: [panel("Phases", "second phase")] });
    deepStrictEqual(board.panels.map((entry) => entry.rows[0].text), ["session task", "second phase"]);
  });

  test("an empty panel earns no place on screen", () => {
    const board = new PanelBoard();
    board.apply({ scope: "s", panels: [{ title: "Plan", rows: [] }] });
    deepStrictEqual(board.panels, []);
    // Rows left out still exist.
    board.apply({ scope: "s", panels: [{ title: "Agents", rows: [], more: 3 }] });
    strictEqual(board.panels.length, 1);
  });

  test("a turn cut short stops its active rows and leaves the rest alone", () => {
    const board = new PanelBoard();
    board.apply({ scope: "s", panels: [{ title: "Agents", rows: [
      { text: "one", state: "active" },
      { text: "two", state: "done" },
      { text: "three", state: "idle" },
    ] }] });
    board.settle();
    deepStrictEqual(board.panels[0].rows.map((row) => row.state), ["stopped", "done", "idle"]);
  });

  test("only what this turn published counts as a change", () => {
    const board = new PanelBoard();
    board.apply({ scope: "tasks", panels: [{ ...panel("Plan", "carried over"), quiet: true }] });
    strictEqual(board.changed, false);
    board.apply({ scope: "tasks", panels: [panel("Plan", "carried over")] });
    strictEqual(board.changed, true);
  });
});

/** Captures whatever the status message renders. */
function fakeApi() {
  const sent: string[] = [];
  const api = {
    raw: {
      sendMessage: async (payload: { text: string }) => {
        sent.push(payload.text);
        return { message_id: sent.length };
      },
      editMessageText: async (payload: { text: string }) => {
        sent.push(payload.text);
        return true;
      },
    },
  } as unknown as Api;
  return { api, sent };
}

describe("quiet panels and reporting tools", () => {
  test("a quiet panel does not earn a status message", async () => {
    // A plan carried over from an earlier turn is worth drawing, but posting a
    // status box for every "hi" in a thread with an open plan is not.
    const { api, sent } = fakeApi();
    const status = new TelegramTurnStatus(api, 1);
    status.panels({ scope: "tasks", panels: [{ ...panel("Plan", "carried over"), quiet: true }] });
    await status.finish("completed");
    deepStrictEqual(sent, []);
  });

  test("but one this turn published does", async () => {
    const { api, sent } = fakeApi();
    const status = new TelegramTurnStatus(api, 1);
    status.panels({ scope: "tasks", panels: [{ ...panel("Plan", "carried over"), quiet: true }] });
    status.panels({ scope: "tasks", panels: [panel("Plan", "carried over")] });
    await status.finish("completed");
    strictEqual(sent.length, 1);
    match(sent[0], /carried over/);
  });

  /** The tool line only exists while the turn runs, so these read the live
   *  render rather than the finished one. */
  const whileRunning = async (drive: (status: TelegramTurnStatus) => void) => {
    const { api, sent } = fakeApi();
    const status = new TelegramTurnStatus(api, 1);
    drive(status);
    await new Promise((resolve) => setTimeout(resolve, 400));
    status.cancel();
    return sent.at(-1) ?? "";
  };
  const fromTool: PanelUpdate = { scope: "call-7", tool: "workflow", panels: [panel("workflow", "scout")] };

  test("a tool publishing its own panels loses its argument preview", async () => {
    // "🔧 workflow · script: export const meta = { name: …" says nothing that
    // the phase list under it doesn't say better.
    const text = await whileRunning((status) => {
      status.tool("workflow", "script: export const meta = { name: \"research\" }");
      status.panels(fromTool);
    });
    match(text, /scout/);
    strictEqual(/🔧/.test(text), false);
    strictEqual(/export const meta/.test(text), false);
  });

  test("a tool that publishes nothing keeps its status line", async () => {
    const text = await whileRunning((status) => {
      status.panels({ scope: "tasks", panels: [panel("Plan", "task")] });
      status.tool("Bash", "npm test");
    });
    match(text, /🔧 Bash · npm test/);
  });

  test("a tool that published once stays suppressed for the rest of the turn", async () => {
    // Claude re-announces a tool call; the panels are still the better story.
    const text = await whileRunning((status) => {
      status.panels(fromTool);
      status.tool("workflow", "script: …");
    });
    strictEqual(/🔧/.test(text), false);
  });
});

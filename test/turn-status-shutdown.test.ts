import assert from "node:assert/strict";
import test from "node:test";
import { TurnStatus, interruptLiveCards, plainStatus } from "../src/channels/turn-status.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function card(name: string, log: string[]) {
  return new TurnStatus({
    post: async (text) => { log.push(`${name} post: ${text.split("\n")[0]}`); },
    edit: async (text) => { log.push(`${name} edit: ${text.split("\n")[0]}`); },
    remove: async () => { log.push(`${name} removed`); },
  }, { render: plainStatus, throttleMs: 1, toolRenderDelayMs: 0 });
}

test("a shutdown settles every card still claiming its turn is working", async () => {
  const log: string[] = [];
  const toolOnly = card("tool", log);
  toolOnly.start();
  toolOnly.tool("Bash", "ls");
  const withPanels = card("panels", log);
  withPanels.start();
  withPanels.panels({ scope: "turn", panels: [{ title: "Plan", rows: [{ text: "Read", state: "active" }] }] });
  const done = card("done", log);
  done.start();
  done.panels({ scope: "turn", panels: [{ title: "Plan", rows: [{ text: "Read", state: "done" }] }] });
  await sleep(300);
  await done.finish("completed");
  log.length = 0;

  await interruptLiveCards();
  // The woken turn posts its own card: the dead one goes, or says it stopped.
  assert.deepEqual(log.sort(), ["panels edit: ⏹ Turn stopped", "tool removed"]);
  await sleep(50);
  assert.equal(log.length, 2, "a settled card draws nothing more");
});

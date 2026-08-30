import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Gateway as GatewayType } from "../src/gateway.ts";
import type { RunnerHooks, TurnEvents } from "../src/agent/runner.ts";

// The gateway's ledgers live in the state directory, which paths.ts resolves at
// import time — so it has to point at a temp dir before the module is loaded.
// (Type-only imports above are erased, so they don't load anything.)
const stateDir = mkdtempSync(join(tmpdir(), "eleven-gateway-"));
process.env.ELEVEN_STATE_DIR = stateDir;
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { Gateway } = await import("../src/gateway.ts");

const config = {
  resolved: { workspaces: { agent: { path: stateDir } }, models: [], session: {} },
  turnModels: () => [{ model: "claude-code/opus" }],
  on: () => {},
};

/** The gateway's own runner is the seam: replace `submit` with a fake turn, so
 *  a test can look at the live record from inside a turn that is still running
 *  — which is exactly the moment a dashboard reads it. */
function stubTurn(gateway: GatewayType, turn: (threadId: string, hooks: RunnerHooks, events: TurnEvents) => void) {
  const runner = gateway.runner as unknown as {
    hooks: RunnerHooks;
    submit: (id: string, request: unknown, events: TurnEvents) => Promise<unknown>;
  };
  runner.submit = async (threadId, _request, events) => {
    turn(threadId, runner.hooks, events);
    return undefined;
  };
}

function send(gateway: GatewayType, text: string) {
  return gateway.handle({ sessionKey: "telegram:main:-1001:topic:7", text, runtime: { channel: "telegram" } });
}

test("the message that starts a turn is in the live record, where a mid-turn page reads it", async () => {
  // Regression: the live record was created empty when the turn started, i.e.
  // *after* the message that started it was pushed — so it was dropped. On a
  // thread's first turn (right after /new) that record is the only copy there
  // is: pi keeps a brand-new session in memory until the model's first reply,
  // so the dashboard has no transcript file to read either, and the message
  // showed up nowhere until the turn ended.
  const gateway = new Gateway(config as never);
  let live: ReturnType<GatewayType["liveTurn"]>;
  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onDelta?.("on it");
    live = structuredClone(gateway.liveTurn(threadId));
  });

  await send(gateway, "check the logs");

  assert.deepEqual(
    live?.items.map((item) => (item.kind === "message" ? { kind: item.kind, role: item.role, text: item.text } : item)),
    [{ kind: "message", role: "user", text: "check the logs" }, { kind: "text", text: "on it" }],
  );
  // The transcript skips a message the live region already draws, but only for
  // rows dated at or after the turn's start — so the record cannot claim to
  // have begun after the message it opens with, or the bubble renders twice.
  const opener = live!.items[0];
  assert.ok(opener.kind === "message" && opener.at >= live!.startedAt);
});

test("a turn does not inherit the previous turn's live record", async () => {
  const gateway = new Gateway(config as never);
  const seen: string[][] = [];
  stubTurn(gateway, (threadId, hooks, events) => {
    hooks.onTurnStart?.(threadId, undefined);
    events.onDelta?.("done");
    seen.push(gateway.liveTurn(threadId)!.items.map((item) => (item.kind === "message" ? item.text : item.kind)));
    // What the runner does once the turn (and its delivery) has settled.
    hooks.onTurnEnd?.(threadId);
  });

  await send(gateway, "first");
  await send(gateway, "second");

  assert.deepEqual(seen, [["first", "text"], ["second", "text"]]);
});

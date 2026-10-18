import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { runWithPanelSink } from "../src/agent/host-api.ts";
import type { PanelUpdate } from "../src/agent/panels.ts";

/* The gap this closes: a pi extension can only speak from inside a tool's
   `execute`, because that is where `onUpdate` lives. An extension that wants to
   show something at any other moment — on turn_start, to draw work it carried
   over — had nowhere to write. */

const host = () => globalThis.eleven!;
const plan = [{ title: "Plan", rows: [{ text: "carried over", state: "idle" }] }];

const collect = (run: () => void) => {
  const seen: PanelUpdate[] = [];
  runWithPanelSink((update) => seen.push(update), run);
  return seen;
};

describe("the eleven host handshake", () => {
  test("is on globalThis, versioned so an extension can feature-detect", () => {
    strictEqual(typeof host().panels, "function");
    strictEqual(host().version, 2);
  });

  test("publishes into the turn that owns the call stack", () => {
    const seen = collect(() => strictEqual(host().panels(plan, { scope: "tasks" }), true));
    deepStrictEqual(seen, [{ scope: "tasks", panels: plan }]);
  });

  test("reaches the turn from inside async work it started", async () => {
    // The sink has to survive an await: an extension handler is deep inside pi's
    // own async agent loop by the time it runs.
    const seen: PanelUpdate[] = [];
    await runWithPanelSink(
      (update) => seen.push(update),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        host().panels(plan, { scope: "s" });
      },
    );
    strictEqual(seen.length, 1);
  });

  test("says so instead of throwing when no turn owns the stack", () => {
    // Under plain pi, or outside a turn, the same extension file must still run.
    strictEqual(host().panels(plan, { scope: "s" }), false);
  });

  test("validates an extension's payload exactly like a tool's", () => {
    const seen = collect(() => {
      strictEqual(host().panels("not an array", { scope: "s" }), false);
      host().panels([{ title: "Plan", rows: [{ text: "kept" }, { state: "done" }] }], { scope: "s" });
    });
    deepStrictEqual(seen, [{ scope: "s", panels: [{ title: "Plan", rows: [{ text: "kept", state: "active" }] }] }]);
  });

  test("an extension that names no scope still gets one of its own", () => {
    const seen = collect(() => host().panels(plan));
    strictEqual(seen[0].scope, "extension");
  });

  test("a sink that throws does not take the caller down with it", () => {
    runWithPanelSink(() => { throw new Error("channel is broken"); }, () => {
      strictEqual(host().panels(plan, { scope: "s" }), false);
    });
  });
});

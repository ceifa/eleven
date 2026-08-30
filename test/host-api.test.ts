import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { runWithActivitySink } from "../src/agent/host-api.ts";
import type { TaskActivityEvent } from "../src/agent/task-activity.ts";

/* The gap this closes: a pi extension can only speak from inside a tool's
   `execute`, because that is where `onUpdate` lives. An extension that wants to
   draw the turn's status at any other moment — on turn_start, to show the plan
   it carried over — had nowhere to write. */

const host = () => globalThis.eleven!;

const collect = (run: () => void) => {
  const seen: TaskActivityEvent[] = [];
  runWithActivitySink((event) => seen.push(event), run);
  return seen;
};

describe("the eleven host handshake", () => {
  test("is on globalThis, versioned so an extension can feature-detect", () => {
    strictEqual(typeof host().activity, "function");
    strictEqual(host().version, 1);
  });

  test("reports into the turn that owns the call stack", () => {
    const seen = collect(() => {
      const delivered = host().activity(
        [{ kind: "plan", tasks: [{ id: "1", title: "carried over", status: "pending" }] }],
        { scope: "tasks", label: "Plan" },
      );
      strictEqual(delivered, true);
    });
    deepStrictEqual(seen, [{
      kind: "plan",
      scope: "tasks",
      label: "Plan",
      tasks: [{ id: "tasks:1", title: "carried over", status: "pending" }],
    }]);
  });

  test("reaches the turn from inside async work it started", async () => {
    // The sink has to survive an await: an extension handler is deep inside pi's
    // own async agent loop by the time it runs.
    const seen: TaskActivityEvent[] = [];
    await runWithActivitySink(
      (event) => seen.push(event),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        host().activity([{ kind: "agent", task: { id: "a", title: "worker", status: "running" } }], { scope: "s" });
      },
    );
    strictEqual(seen.length, 1);
  });

  test("says so instead of throwing when no turn owns the stack", () => {
    // Under plain pi, or outside a turn, the same extension file must still run.
    strictEqual(host().activity([{ kind: "plan", tasks: [] }], { scope: "s" }), false);
  });

  test("validates an extension's payload exactly like a tool's", () => {
    const seen = collect(() => {
      host().activity("not an array", { scope: "s" });
      host().activity([{ kind: "nonsense" }], { scope: "s" });
      host().activity([{ kind: "plan", tasks: [{ id: "ok", title: "kept" }, { title: "no id" }] }], { scope: "s" });
    });
    strictEqual(seen.length, 1);
    strictEqual(seen[0].kind === "plan" && seen[0].tasks.length, 1);
  });

  test("falls back to a usable scope rather than colliding with the session plan", () => {
    // An unscoped snapshot is the *session's* plan and would evict it. An
    // extension that names nothing still gets a scope of its own.
    const seen = collect(() => host().activity([{ kind: "plan", tasks: [{ id: "1", title: "t", status: "pending" }] }]));
    strictEqual(seen[0].kind === "plan" && seen[0].scope, "extension");
    strictEqual(seen[0].kind === "plan" && seen[0].tasks[0].id, "extension:1");
  });

  test("a sink that throws does not take the caller down with it", () => {
    runWithActivitySink(() => { throw new Error("channel is broken"); }, () => {
      strictEqual(host().activity([{ kind: "plan", tasks: [] }], { scope: "s" }), false);
    });
  });
});

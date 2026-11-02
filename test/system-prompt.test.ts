import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";

test("the built-in prompt allows useful progress without tool narration", () => {
  assert.match(BUILTIN_SYSTEM_PROMPT, /meaningful milestones/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /when blocked/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /Never narrate tool calls, commands, or routine steps/);
  assert.doesNotMatch(BUILTIN_SYSTEM_PROMPT, /Never narrate tool calls or describe what you are about to do/);
});

test("the system prompt stays identical across local midnight", async (t) => {
  const { buildSystemPrompt } = await import("../src/agent/system-prompt.ts");
  const previous = process.env.TZ;
  process.env.TZ = "America/Sao_Paulo";
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T02:59:00Z") });
  const runtime = { channel: "discord", workspace: "test", workspacePath: "/tmp/test" };
  const before = buildSystemPrompt(runtime);
  t.mock.timers.setTime(new Date("2026-11-02T03:01:00Z").getTime());
  assert.equal(buildSystemPrompt(runtime), before);
  assert.doesNotMatch(before, /Today:/);
});

test("date context respects the timezone, skips repeats, and returns after context was compacted away", async (t) => {
  const { dateContextMessage } = await import("../src/agent/turn-context.ts");
  const previous = process.env.TZ;
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T01:00:00Z") });
  delete process.env.TZ;
  const first = dateContextMessage([])!;
  assert.match(first.content, /Sunday, November 1, 2026 \(America\/Sao_Paulo\)/);
  assert.equal(first.display, false);
  const message = { ...first, role: "custom" as const, timestamp: Date.now() };
  assert.equal(dateContextMessage([message]), undefined);
  process.env.TZ = "UTC";
  assert.match(dateContextMessage([message])!.content, /Monday, November 2, 2026 \(UTC\)/);
  assert.ok(dateContextMessage([]), "a summary without the date marker must get a fresh update");
});

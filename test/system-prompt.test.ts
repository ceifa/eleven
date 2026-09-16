import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";

test("the built-in prompt allows useful progress without tool narration", () => {
  assert.match(BUILTIN_SYSTEM_PROMPT, /meaningful milestones/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /when blocked/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /Never narrate tool calls, commands, or routine steps/);
  assert.doesNotMatch(BUILTIN_SYSTEM_PROMPT, /Never narrate tool calls or describe what you are about to do/);
});

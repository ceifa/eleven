import assert from "node:assert/strict";
import test from "node:test";
import { syncTelegramCommands } from "../src/channels/telegram/bot.ts";

test("Telegram command sync removes stale group-scoped commands", async () => {
  const calls: Array<{ method: string; value: unknown }> = [];
  const api = {
    setMyCommands: async (commands: unknown) => {
      calls.push({ method: "set", value: commands });
      return true as const;
    },
    deleteMyCommands: async (options: unknown) => {
      calls.push({ method: "delete", value: options });
      return true as const;
    },
  };

  await syncTelegramCommands(api as never);

  assert.deepEqual(calls, [
    {
      method: "set",
      value: [
        { command: "new", description: "Start a fresh thread" },
        { command: "skills", description: "List the skills the agent can use here" },
        { command: "usage", description: "Show model subscription usage" },
        { command: "stop", description: "Abort the running turn" },
      ],
    },
    { method: "delete", value: { scope: { type: "all_group_chats" } } },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { formatTelegramInboundPrompt, syncTelegramCommands } from "../src/channels/telegram/bot.ts";

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

test("group attribution wraps the complete inbound body while DMs stay bare", () => {
  const group = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: { from: { id: 42, first_name: "Gabriel", username: "c3if4" } },
  };
  const body = "[Transcript]\nVamos em outubro.";

  assert.equal(formatTelegramInboundPrompt(group as never, body), "[Gabriel @c3if4]\n[Transcript]\nVamos em outubro.");
  assert.equal(formatTelegramInboundPrompt({ chat: { type: "private" } } as never, body), body);
});

test("Telegram reply context prefers the selected quote", () => {
  const ctx = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: {
      from: { id: 42, first_name: "Gabriel", username: "c3if4" },
      quote: { text: "o hotel em setembro custa R$ 4.800", position: 20, is_manual: true },
      reply_to_message: {
        from: { id: 43, first_name: "Samara", last_name: "Lana" },
        text: "Uma mensagem original muito maior que contém o trecho selecionado.",
      },
    },
  };

  assert.equal(
    formatTelegramInboundPrompt(ctx as never, "Você considerou isso?"),
    '[Gabriel @c3if4]\n[Replying to Samara Lana: "o hotel em setembro custa R$ 4.800"]\nVocê considerou isso?',
  );
});

test("long implicit reply quotes keep a compact head and tail", () => {
  const original = `${"A".repeat(130)} middle ${"Z".repeat(80)}`;
  const ctx = {
    chat: { type: "group" },
    me: { id: 999 },
    message: {
      from: { id: 42, first_name: "Gabriel" },
      reply_to_message: { from: { id: 43, first_name: "Samara" }, text: original },
    },
  };

  assert.equal(
    formatTelegramInboundPrompt(ctx as never, "Concordo."),
    `[Gabriel]\n[Replying to Samara: "${"A".repeat(120)}…${"Z".repeat(70)}"]\nConcordo.`,
  );
});

test("media replies identify the bot as you without copying ids", () => {
  const ctx = {
    chat: { type: "supergroup" },
    me: { id: 999 },
    message: {
      from: { id: 42, first_name: "Gabriel" },
      reply_to_message: { from: { id: 999, first_name: "Mortar", is_bot: true }, photo: [{}] },
    },
  };

  assert.equal(
    formatTelegramInboundPrompt(ctx as never, "Essa aqui."),
    "[Gabriel]\n[Replying to your photo]\nEssa aqui.",
  );
});

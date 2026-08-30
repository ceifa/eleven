import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api } from "grammy";
import { sendRich } from "../src/channels/telegram/rich.ts";
import { forgetEphemeralRefusal } from "../src/channels/telegram/ephemeral.ts";

/** A chat where the bot is not an admin: ephemeral sends fail the way Telegram
 * fails them, everything else goes through. */
function fakeApi(reject: (payload: Record<string, unknown>) => string | undefined) {
  const calls: Record<string, unknown>[] = [];
  const api = {
    raw: {
      sendRichMessage: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        const description = reject(payload);
        if (description) throw Object.assign(new Error(description), { description, error_code: 400 });
        return { message_id: calls.length };
      },
    },
  } as unknown as Api;
  return { api, calls };
}

const ephemeralOf = (payload: Record<string, unknown>) =>
  (payload.ephemeral_message_parameters as { receiver_user_id: number } | undefined)?.receiver_user_id;

/** The refusal memo is keyed by chat and lives as long as the process, so each
 * test needs a chat of its own. */
let nextChatId = -1000;
const freshChat = () => nextChatId--;

describe("sendRich ephemeral fallback", () => {
  test("falls back to an ordinary message when the bot is not an admin", async () => {
    // Regression: BOT_NOT_ADMIN threw straight out of sendRich, so every group
    // command reply (/stop, /new, /skills, /usage) was silently dropped.
    const { api, calls } = fakeApi((p) => (ephemeralOf(p) ? "Bad Request: BOT_NOT_ADMIN" : undefined));
    const sent = await sendRich(api, freshChat(), "⏹ Stopped.", { ephemeralTo: 42, messageThreadId: 8 });

    strictEqual(calls.length, 2);
    strictEqual(ephemeralOf(calls[0]), 42);
    strictEqual(ephemeralOf(calls[1]), undefined);
    // The retry is the same message in the same topic, not a degraded one.
    deepStrictEqual(calls[1].rich_message, { markdown: "⏹ Stopped." });
    strictEqual(calls[1].message_thread_id, 8);
    ok(sent);
  });

  test("stops probing ephemeral in a chat that already refused", async () => {
    // Regression: the fallback re-learned the refusal on every message, burning
    // a rejected API call per send in every group the bot isn't an admin of.
    const chatId = freshChat();
    const { api, calls } = fakeApi((p) => (ephemeralOf(p) ? "Bad Request: BOT_NOT_ADMIN" : undefined));
    await sendRich(api, chatId, "first", { ephemeralTo: 42 });
    await sendRich(api, chatId, "second", { ephemeralTo: 42 });

    strictEqual(calls.length, 3);
    strictEqual(ephemeralOf(calls[2]), undefined);
    deepStrictEqual(calls[2].rich_message, { markdown: "second" });
  });

  test("a refusal in one chat leaves the others alone", async () => {
    const refusing = freshChat();
    const { api, calls } = fakeApi((p) =>
      ephemeralOf(p) && p.chat_id === refusing ? "Bad Request: BOT_NOT_ADMIN" : undefined,
    );
    await sendRich(api, refusing, "here", { ephemeralTo: 42 });
    await sendRich(api, freshChat(), "there", { ephemeralTo: 42 });

    strictEqual(calls.length, 3);
    strictEqual(ephemeralOf(calls[2]), 42);
  });

  test("forgetting the refusal probes ephemeral again", async () => {
    // A promotion to admin arrives as my_chat_member; ephemeral must come back
    // without waiting for a restart.
    const chatId = freshChat();
    let admin = false;
    const { api, calls } = fakeApi((p) => (ephemeralOf(p) && !admin ? "Bad Request: BOT_NOT_ADMIN" : undefined));
    await sendRich(api, chatId, "before", { ephemeralTo: 42 });
    admin = true;
    forgetEphemeralRefusal(chatId);
    await sendRich(api, chatId, "after", { ephemeralTo: 42 });

    strictEqual(calls.length, 3);
    strictEqual(ephemeralOf(calls[2]), 42);
  });

  test("keeps ephemeral delivery where the chat accepts it", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await sendRich(api, freshChat(), "⏹ Stopped.", { ephemeralTo: 42 });
    strictEqual(calls.length, 1);
    strictEqual(ephemeralOf(calls[0]), 42);
  });

  test("still surfaces unrelated failures instead of resending", async () => {
    const { api, calls } = fakeApi(() => "Bad Request: chat not found");
    await sendRich(api, freshChat(), "hi", { ephemeralTo: 42 }).then(
      () => ok(false, "expected sendRich to reject"),
      (error: Error) => ok(String(error).includes("chat not found")),
    );
    strictEqual(calls.length, 1);
  });
});

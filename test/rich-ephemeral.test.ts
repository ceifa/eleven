import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api } from "grammy";
import { sendRich } from "../src/channels/telegram/rich.ts";

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

describe("sendRich ephemeral fallback", () => {
  test("falls back to an ordinary message when the bot is not an admin", async () => {
    // Regression: BOT_NOT_ADMIN threw straight out of sendRich, so every group
    // command reply (/stop, /new, /skills, /usage) was silently dropped.
    const { api, calls } = fakeApi((p) => (ephemeralOf(p) ? "Bad Request: BOT_NOT_ADMIN" : undefined));
    const sent = await sendRich(api, -100, "⏹ Stopped.", { ephemeralTo: 42, messageThreadId: 8 });

    strictEqual(calls.length, 2);
    strictEqual(ephemeralOf(calls[0]), 42);
    strictEqual(ephemeralOf(calls[1]), undefined);
    // The retry is the same message in the same topic, not a degraded one.
    deepStrictEqual(calls[1].rich_message, { markdown: "⏹ Stopped." });
    strictEqual(calls[1].message_thread_id, 8);
    ok(sent);
  });

  test("keeps ephemeral delivery where the chat accepts it", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await sendRich(api, -100, "⏹ Stopped.", { ephemeralTo: 42 });
    strictEqual(calls.length, 1);
    strictEqual(ephemeralOf(calls[0]), 42);
  });

  test("still surfaces unrelated failures instead of resending", async () => {
    const { api, calls } = fakeApi(() => "Bad Request: chat not found");
    await sendRich(api, -100, "hi", { ephemeralTo: 42 }).then(
      () => ok(false, "expected sendRich to reject"),
      (error: Error) => ok(String(error).includes("chat not found")),
    );
    strictEqual(calls.length, 1);
  });
});

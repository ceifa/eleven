import { z } from "zod";
import type { DashboardContext } from "../context.ts";
import { ApiError, body } from "../http.ts";
import type { Route } from "../router.ts";
import { threadViews } from "../thread-view.ts";

// One Telegram rich-message request: avoids ambiguous partial delivery and
// duplicate prefixes when a multi-chunk send fails midway.
const MAX_OUTBOUND_MESSAGE_CHARS = 32_000;

/** What reaches a chat: where a message can go, text delivered into a
 *  thread's conversation, and who gets to talk to the bots at all. */
export function channelRoutes(context: DashboardContext): Route[] {
  const { gateway, channels } = context;
  const { resolveThreadRef } = threadViews(context);

  return [
    {
      method: "GET",
      pattern: "/channels/destinations",
      async handler({ send }) {
        return send(200, await channels.destinations());
      },
    },
    {
      method: "GET",
      pattern: "/channels/destination",
      async handler({ url, send }) {
        const sessionKey = z.string().min(1).parse(url.searchParams.get("sessionKey"));
        return send(200, await channels.describe(sessionKey));
      },
    },
    {
      method: "POST",
      pattern: "/channels/thread",
      async handler({ req, send }) {
        const request = z.object({
          sessionKey: z.string().min(1),
          name: z.string().trim().min(1).max(100),
          persistent: z.boolean().optional(),
          text: z.string().trim().min(1).max(MAX_OUTBOUND_MESSAGE_CHARS),
        }).parse(await body(req));
        return send(201, await channels.openThread(request.sessionKey, request.name, request.text, request.persistent));
      },
    },
    {
      method: "POST",
      pattern: "/threads/:id/:action(prompt|archive)",
      async handler({ req, params, send }) {
        const thread = resolveThreadRef(params.id);
        if (!gateway.threads.isCurrent(thread.id)) throw new ApiError(409, "thread is old; use the current conversation");
        if (params.action === "archive") await channels.archive(thread.sessionKey);
        else {
          const { text } = z.object({ text: z.string().trim().min(1).max(MAX_OUTBOUND_MESSAGE_CHARS) }).parse(await body(req));
          await channels.prompt(thread.sessionKey, text);
        }
        return send(202, { ok: true, threadId: thread.id });
      },
    },
    {
      method: "POST",
      pattern: "/threads/:id/send",
      async handler({ req, params, send }) {
        const thread = resolveThreadRef(params.id);
        const { text } = (await body(req)) as { text: string };
        if (!text?.trim()) throw new Error("message is required");
        if (text.length > MAX_OUTBOUND_MESSAGE_CHARS) throw new ApiError(413, "message is too large");
        if (!gateway.threads.isCurrent(thread.id)) {
          const current = gateway.threads.current(thread.sessionKey);
          throw new Error(`thread is old${current ? `; current thread is ${current.id.slice(0, 8)}` : ""}`);
        }
        const delivery = await gateway.deliverOutbound(thread.id, text, () => channels.sendToSession(thread.sessionKey, text));
        return send(200, { ok: true, threadId: thread.id, ...delivery });
      },
    },
    {
      method: "POST",
      pattern: "/pairing/:requestId/:action(approve|deny)",
      async handler({ params, send }) {
        const { requestId, action } = params;
        const request = action === "approve" ? await channels.approvePairing(requestId) : channels.denyPairing(requestId);
        return send(200, request);
      },
    },
  ];
}

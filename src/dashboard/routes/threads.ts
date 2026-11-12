import { z } from "zod";
import { conversationModelScopes } from "../../channels/session-key.ts";
import { readThreadTimeline, readToolResult } from "../../threads/reader.ts";
import { threadSnapshot, THREAD_SNAPSHOT_TAIL, THREAD_SNAPSHOT_MAX_TAIL } from "../../threads/snapshot.ts";
import { readSessionUsage } from "../../threads/usage.ts";
import { displayTitle } from "../../threads/title.ts";
import { findModel } from "../../agent/pi.ts";
import type { DashboardContext } from "../context.ts";
import type { Route } from "../router.ts";
import { threadUsage, threadViews } from "../thread-view.ts";

/** Reading threads — the list, one transcript, the pieces fetched on demand —
 *  and deleting one. What runs a turn in a thread is in turns.ts. */
export function threadRoutes(context: DashboardContext): Route[] {
  const { config, gateway, broadcast, channelConfigs, identityOf } = context;
  const { resolveThreadRef, threadView, listThreadViews } = threadViews(context);

  return [
    {
      method: "GET",
      pattern: "/threads",
      async handler({ url, send }) {
        return send(200, await listThreadViews(url));
      },
    },
    {
      method: "GET",
      pattern: "/threads/:id/read",
      async handler({ url, params, send }) {
        const thread = resolveThreadRef(params.id);
        const tail = z.coerce.number().int().min(1).max(THREAD_SNAPSHOT_MAX_TAIL)
          .parse(url.searchParams.get("tail") ?? THREAD_SNAPSHOT_TAIL);
        const timeline = thread.sessionFile ? await readThreadTimeline(thread.sessionFile) : [];
        return send(200, {
          thread: { id: thread.id, workspace: thread.workspace, title: displayTitle(thread.title), conversation: identityOf(thread.sessionKey).label },
          ...threadSnapshot(timeline, tail),
        });
      },
    },
    {
      method: "GET",
      pattern: "/threads/:id",
      async handler({ params, send }) {
        const thread = resolveThreadRef(params.id);
        const [timeline, requests, samples] = await Promise.all([
          thread.sessionFile ? readThreadTimeline(thread.sessionFile) : [],
          gateway.requests.list(thread.id),
          thread.sessionFile ? readSessionUsage(thread.sessionFile) : [],
        ]);
        const messages = timeline.flatMap((item) => (item.kind === "message" ? [item] : []));
        const workspace = config.resolved.workspaces[thread.workspace];
        const effectiveModel = workspace
          ? config.turnModels(thread.model, [...conversationModelScopes(thread.sessionKey, channelConfigs()), workspace])
              .map((candidate) => candidate.model)
              .find((ref) => findModel(ref))
          : undefined;
        return send(200, {
          thread: {
            ...threadView(thread, { detail: true }),
            effectiveModel,
            lastModel: requests.at(-1)?.model,
            messages: messages.length,
            turns: messages.filter((message) => message.role === "user").length,
            usage: threadUsage(samples, effectiveModel),
          },
          timeline,
          requests,
          // Catch-up for a page opened mid-turn: what the running turn already
          // did, in order (WS events only reach pages already connected).
          live: gateway.liveTurn(thread.id),
        });
      },
    },
    {
      method: "GET",
      pattern: "/requests/:threadId/:requestId",
      async handler({ params, send }) {
        const { threadId, requestId } = params;
        const entry = await gateway.requests.get(threadId, requestId);
        if (!entry) return send(404, { error: "request not found" });
        return send(200, entry);
      },
    },
    // Tool-call output, fetched on click. The call id goes in a query param
    // (it can contain "|" and other path-hostile characters).
    {
      method: "GET",
      pattern: "/threads/:id/toolresult",
      async handler({ url, params, send }) {
        const thread = gateway.threads.get(params.id);
        const call = url.searchParams.get("call");
        if (!thread?.sessionFile || !call) return send(404, { error: "not found" });
        const result = await readToolResult(thread.sessionFile, call);
        if (!result) return send(404, { error: "result not found" });
        return send(200, result);
      },
    },
    {
      method: "DELETE",
      pattern: "/threads/:id",
      async handler({ params, send }) {
        const id = params.id;
        const workspace = gateway.threads.get(id)?.workspace;
        if (!(await gateway.deleteThread(id))) return send(404, { error: "thread not found" });
        // Other open dashboards drop the thread from their list too.
        broadcast({ type: "thread-deleted", threadId: id, workspace });
        return send(200, { ok: true });
      },
    },
  ];
}

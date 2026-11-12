import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { entryKey, type ModelEntry } from "../../config.ts";
import { TurnFailure } from "../../agent/turn.ts";
import { continuePrompt } from "../../channels/failover.ts";
import { collectStoredMedia, formatInboundBody, type StoredAttachment } from "../../media-store.ts";
import { logger } from "../../log.ts";
import type { DashboardContext } from "../context.ts";
import { ApiError, body } from "../http.ts";
import type { Route } from "../router.ts";
import { threadViews } from "../thread-view.ts";
import { dashboardTool } from "../tool.ts";

const log = logger("dashboard");

/** Turns typed here or sent by the CLI: starting a thread, adding a message to
 *  one, stopping it, starting it over. */
export function turnRoutes(context: DashboardContext): Route[] {
  const { config, gateway, channels, identityOf } = context;
  const { resolveThreadRef, threadView, composable } = threadViews(context);
  const cliRuns = new Map<string, { status: "running" | "done" | "error"; result?: unknown; error?: string }>();

  /**
   * The prompt a composer's submission becomes: its text, the note per uploaded
   * file so the agent can open it, the transcript of anything recorded — the
   * same body an inbound Telegram message produces, so a turn cannot tell the
   * two apart. Images additionally ride along for the model to look at.
   */
  async function composeInbound(text: unknown, attachments: unknown) {
    const refs = Array.isArray(attachments)
      ? attachments.flatMap((entry): StoredAttachment[] => {
          const { id, mime, voice } = (entry ?? {}) as Record<string, unknown>;
          return typeof id === "string" ? [{ id, mime: typeof mime === "string" ? mime : undefined, voice: voice === true }] : [];
        })
      : [];
    const userText = typeof text === "string" ? text.trim() : "";
    if (!refs.length) return { text: userText, images: [] };
    const media = await collectStoredMedia(refs, config.resolved.transcription?.command);
    return { text: formatInboundBody(userText, media), images: media.images };
  }

  async function runLocalTurn(sessionKey: string, message: string, source: "dashboard" | "cli", images: ImageContent[] = []) {
    let text = message;
    let models: ModelEntry[] | undefined;
    // turn-done/turn-error reach the UI via the gateway's own events.
    for (;;) {
      try {
        return await gateway.handle({
          sessionKey,
          text,
          images: !models && images.length ? images : undefined,
          models,
          // The CLI prints the answer and is gone: nobody is left to press a button.
          customTools: source === "dashboard" ? [dashboardTool] : undefined,
          runtime: {
            channel: source,
            conversation: source === "cli" ? "eleven CLI" : "eleven web dashboard",
            capabilities: source === "dashboard" ? ["rich markdown", "buttons — via the dashboard tool"] : ["rich markdown"],
          },
          workspaceHint: gateway.threads.current(sessionKey)?.workspace,
        });
      } catch (error) {
        // The runner stops instead of failing over once an attempt ran tools — a
        // quota spent mid-turn, the way a long cron run dies. With auto-failover
        // on, pick the turn up on the untried tail, as a Telegram turn does; the
        // tail is strictly shorter each time, so this ends.
        if (config.resolved.autoFailover === true && error instanceof TurnFailure && error.remaining.length) {
          log.warn(`${source} turn failed on ${error.failedModel}, continuing on ${entryKey(error.remaining[0]!)}: ${error.message}`);
          models = error.remaining;
          text = continuePrompt(error.hiddenToolCalls);
          continue;
        }
        log.warn(`${source} turn failed: ${error}`);
        throw error;
      }
    }
  }

  return [
    {
      method: "GET",
      pattern: "/threads/:id/run",
      handler({ params, send }) {
        const thread = resolveThreadRef(params.id);
        const run = cliRuns.get(thread.id);
        if (!run) throw new ApiError(404, "no CLI run is tracked for this thread");
        return send(200, run);
      },
    },
    {
      method: "POST",
      pattern: "/threads",
      async handler({ req, send }) {
        const request = (await body(req)) as { workspace: string; text: string; source?: string; attachments?: unknown };
        const { workspace } = request;
        if (!config.resolved.workspaces[workspace]) throw new Error(`workspace ${workspace} not found`);
        const { text, images } = await composeInbound(request.text, request.attachments);
        if (!text.trim() && !images.length) throw new Error("message is required");
        const source = request.source === "cli" ? "cli" : "dashboard";
        const sessionKey = `${source}:${workspace}:${randomUUID()}`;
        const thread = gateway.newThread(sessionKey, workspace);
        if (source === "cli") {
          cliRuns.set(thread.id, { status: "running" });
          while (cliRuns.size > 100) {
            const evictable = [...cliRuns].find(([, run]) => run.status !== "running")?.[0];
            if (!evictable) break;
            cliRuns.delete(evictable);
          }
          void runLocalTurn(sessionKey, text, source, images).then(
            (result) => cliRuns.set(thread.id, { status: "done", result }),
            (error) => cliRuns.set(thread.id, { status: "error", error: error instanceof Error ? error.message : String(error) }),
          );
          return send(201, threadView(thread));
        }
        void runLocalTurn(sessionKey, text, source, images).catch(() => {});
        return send(201, threadView(thread));
      },
    },
    // The dashboard's stop button — Telegram's /stop for the thread you are
    // looking at. Buffered input goes with it: a burst still waiting out its
    // quiet window would otherwise start a turn a second after the stop.
    {
      method: "POST",
      pattern: "/threads/:id/interrupt",
      async handler({ params, send }) {
        const thread = resolveThreadRef(params.id);
        const dropped = gateway.threads.isCurrent(thread.id) && channels.discardPending(thread.sessionKey);
        const stopped = await gateway.interruptThread(thread.id);
        return send(200, { stopped, dropped });
      },
    },
    // The dashboard's /new. The launcher starts a thread in a conversation of
    // its own, which is no use when what you want is a fresh start *here* —
    // in the Telegram topic (or DM) this thread belongs to, so the agent's
    // replies keep landing where the conversation lives.
    {
      method: "POST",
      pattern: "/threads/:id/new",
      async handler({ params, send }) {
        const thread = resolveThreadRef(params.id);
        // Fresh means fresh, exactly as in Telegram: buffered input and the
        // in-flight turn belong to the thread being left behind.
        channels.discardPending(thread.sessionKey);
        await gateway.interrupt(thread.sessionKey);
        const started = gateway.newThread(thread.sessionKey, thread.workspace);
        return send(201, threadView(started));
      },
    },
    {
      method: "POST",
      pattern: "/threads/:id/message",
      async handler({ req, params, send }) {
        const thread = resolveThreadRef(params.id);
        if (!composable(thread.sessionKey)) {
          throw new ApiError(409, `this thread lives in ${identityOf(thread.sessionKey).label}. Answer it there, or start a thread of your own here.`);
        }
        const request = (await body(req)) as { text: string; attachments?: unknown };
        const { text, images } = await composeInbound(request.text, request.attachments);
        if (!text.trim() && !images.length) throw new Error("message is required");
        void runLocalTurn(thread.sessionKey, text, "dashboard", images).catch(() => {});
        // The composer uses this exact body to replace its upload-receipt
        // preview. It includes absolute paths and voice transcription — exactly
        // what the agent received, and exactly what ⚡ promises to expose.
        return send(202, { ok: true, message: text });
      },
    },
  ];
}

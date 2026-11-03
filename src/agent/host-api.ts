import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { readPanels, type PanelUpdate } from "./panels.ts";
import { logger } from "../log.ts";

const log = logger("host-api");

/**
 * What eleven offers a workspace extension, beyond what pi gives it.
 *
 * A pi extension can only speak to the outside world from inside a tool's
 * `execute` — that is where `onUpdate` lives, and pi has no host-service channel
 * of its own. So an extension that wants to show something at any other moment
 * (on `turn_start`, say, to draw work it carried over from the previous turn)
 * has nowhere to write.
 *
 * eleven hands it one, over a `globalThis` handshake. That is the only mechanism
 * available: pi loads workspace extensions itself and decides what context they
 * receive, and an extension in a workspace directory has no import path back to
 * whichever eleven happens to be hosting it. Feature-detection is the point of
 * `version` — the same extension file has to keep working under plain pi, where
 * this object simply isn't there.
 *
 * This grants no new authority. A workspace extension already runs in-process
 * with the tools the workspace granted it; this only lets it describe what it is
 * doing, and everything it sends is validated exactly like a tool's report.
 */
export interface ElevenHost {
  /** Bumped when the shape grows or changes. */
  readonly version: 4;
  /**
   * Replace this producer's panels in the turn currently running on this call
   * stack (see panels.ts). `scope` identifies the producer: its panels replace
   * its own and nothing else. Returns false when there is no turn to show them
   * in — under plain pi, or when called outside one — so a caller can tell
   * "not shown" from "shown".
   */
  panels(panels: unknown, options?: { scope?: string }): boolean;
  /**
   * The conversation the turn on this call stack belongs to, held past the
   * turn's end: work an extension started in the background reports back with
   * `wake(text)`, which runs `text` as a message in that conversation (steered
   * into its running turn, if there is one). Undefined when no turn owns the
   * stack, or its conversation cannot take a turn nobody typed — the caller
   * then has to finish inside the tool call. `wake` resolves false when the
   * conversation has since moved on to a new thread, or delivery failed.
   * The handle keeps the runtime alive until `finish` or `wake`. Its signal
   * aborts on /new or its own Stop button, independently of the turn's signal.
   */
  conversation(options?: { title?: string }): BackgroundConversation | undefined;
  /**
   * Run `operation` so that the model sessions it spawns work in `cwd` instead
   * of the workspace — a subagent isolated in its own git worktree. Pi's own
   * tools already take a cwd; this carries it to runtimes eleven bridges.
   */
  inDirectory<T>(cwd: string, operation: () => T): T;
}

export type BackgroundOutcome = "completed" | "failed" | "stopped";

export interface BackgroundStatus {
  panels(update: PanelUpdate): void;
  finish(outcome: BackgroundOutcome): Promise<void>;
}

export interface BackgroundConversation {
  /** Aborted by this run's Stop button or by ending its originating session. */
  readonly signal: AbortSignal;
  progress(panels: unknown): boolean;
  /** Settle the card and release the runtime after the workers wind down. */
  finish(outcome: BackgroundOutcome): Promise<void>;
  wake(text: string): Promise<boolean>;
}

export type BackgroundStatusFactory = (options: { title: string; stop: () => void }) => BackgroundStatus;

/** What eleven knows about the turn on this call stack. */
export interface TurnContext {
  panels: (update: PanelUpdate) => void;
  /** Start a turn in this conversation; absent when it cannot be woken. */
  wake?: (text: string) => Promise<void>;
  sessionSignal?: AbortSignal;
  createBackground?: BackgroundStatusFactory;
  /** Keep the conversation's runtime alive until the returned release runs. */
  hold?: () => () => void;
}

const turnContext = new AsyncLocalStorage<TurnContext>();
const directory = new AsyncLocalStorage<string>();

/** Run `operation` as the turn `context` describes. Everything the turn
 *  reaches — pi's agent loop, extension handlers, tool executions — is inside it. */
export function runInTurn<T>(context: TurnContext, operation: () => T): T {
  return turnContext.run(context, operation);
}

/** The directory an extension asked nested sessions on this stack to work in. */
export function nestedDirectory(): string | undefined {
  return directory.getStore();
}

const host: ElevenHost = {
  version: 4,
  panels(panels, options = {}) {
    const sink = turnContext.getStore()?.panels;
    if (!sink) return false;
    const update = readPanels(panels, options.scope?.trim() || "extension");
    if (!update) return false;
    try {
      sink(update);
    } catch (error) {
      // Reporting progress must never be able to fail whatever was reporting it.
      log.warn(`extension panel report failed: ${error}`);
      return false;
    }
    return true;
  },
  conversation(options = {}) {
    const turn = turnContext.getStore();
    const { wake, sessionSignal, createBackground } = turn ?? {};
    if (!wake) return undefined;
    const release = turn?.hold?.() ?? (() => {});
    const controller = new AbortController();
    const abort = () => controller.abort();
    sessionSignal?.addEventListener("abort", abort, { once: true });
    if (sessionSignal?.aborted) abort();
    let status: BackgroundStatus | undefined;
    let finished = false;
    const finish = async (outcome: BackgroundOutcome) => {
      if (finished) return;
      finished = true;
      sessionSignal?.removeEventListener("abort", abort);
      release();
      try {
        await status?.finish(outcome);
      } catch (error) {
        log.warn(`background status finish failed: ${error}`);
      }
    };
    return {
      signal: controller.signal,
      progress(panels) {
        if (finished || controller.signal.aborted || !createBackground) return false;
        const update = readPanels(panels, "background");
        if (!update) return false;
        try {
          status ??= createBackground({ title: options.title?.trim() || "Background work", stop: abort });
          status.panels(update);
          return true;
        } catch (error) {
          log.warn(`background progress failed: ${error}`);
          return false;
        }
      },
      finish,
      async wake(text) {
        if (typeof text !== "string" || !text.trim()) return false;
        await finish(controller.signal.aborted ? "stopped" : "completed");
        if (sessionSignal?.aborted) return false;
        try {
          await wake(text.trim());
          return true;
        } catch (error) {
          log.warn(`extension wake failed: ${error}`);
          return false;
        }
      },
    };
  },
  inDirectory(cwd, operation) {
    return directory.run(resolve(cwd), operation);
  },
};

declare global {
  // eslint-disable-next-line no-var
  var eleven: ElevenHost | undefined;
}

/** Publish the handshake. Idempotent, and it never clobbers a newer host. */
export function installHostApi(): void {
  if (globalThis.eleven && globalThis.eleven.version >= host.version) return;
  globalThis.eleven = host;
}

installHostApi();

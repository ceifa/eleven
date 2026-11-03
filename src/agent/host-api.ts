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
  readonly version: 3;
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
   * Until `wake` is called the handle keeps the conversation's runtime alive
   * through idle eviction, so background work must end with it.
   */
  conversation(): { wake(text: string): Promise<boolean> } | undefined;
  /**
   * Run `operation` so that the model sessions it spawns work in `cwd` instead
   * of the workspace — a subagent isolated in its own git worktree. Pi's own
   * tools already take a cwd; this carries it to runtimes eleven bridges.
   */
  inDirectory<T>(cwd: string, operation: () => T): T;
}

/** What eleven knows about the turn on this call stack. */
export interface TurnContext {
  panels: (update: PanelUpdate) => void;
  /** Start a turn in this conversation; absent when it cannot be woken. */
  wake?: (text: string) => Promise<void>;
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
  version: 3,
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
  conversation() {
    const turn = turnContext.getStore();
    const wake = turn?.wake;
    if (!wake) return undefined;
    const release = turn.hold?.() ?? (() => {});
    return {
      async wake(text) {
        if (typeof text !== "string" || !text.trim()) return false;
        release();
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

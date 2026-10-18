import { AsyncLocalStorage } from "node:async_hooks";
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
  /** Bumped when the shape changes incompatibly. */
  readonly version: 2;
  /**
   * Replace this producer's panels in the turn currently running on this call
   * stack (see panels.ts). `scope` identifies the producer: its panels replace
   * its own and nothing else. Returns false when there is no turn to show them
   * in — under plain pi, or when called outside one — so a caller can tell
   * "not shown" from "shown".
   */
  panels(panels: unknown, options?: { scope?: string }): boolean;
}

/** The sink of the turn on this call stack, if a turn owns it. */
const turnSink = new AsyncLocalStorage<(update: PanelUpdate) => void>();

/** Run `operation` as the turn that owns `sink`. Everything the turn reaches —
 *  pi's agent loop, extension handlers, tool executions — is inside it. */
export function runWithPanelSink<T>(sink: (update: PanelUpdate) => void, operation: () => T): T {
  return turnSink.run(sink, operation);
}

const host: ElevenHost = {
  version: 2,
  panels(panels, options = {}) {
    const sink = turnSink.getStore();
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

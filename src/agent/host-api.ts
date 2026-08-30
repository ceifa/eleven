import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeActivity, type TaskActivityEvent } from "./task-activity.ts";
import { logger } from "../log.ts";

const log = logger("host-api");

/**
 * What eleven offers a workspace extension, beyond what pi gives it.
 *
 * A pi extension can only speak to the outside world from inside a tool's
 * `execute` — that is where `onUpdate` lives, and pi has no host-service channel
 * of its own. So an extension that wants to paint the turn's status UI at any
 * other moment (on `turn_start`, say, to show a plan it carried over from the
 * previous turn) has nowhere to write.
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
  readonly version: 1;
  /**
   * Report progress for the turn currently running on this call stack.
   *
   * `scope` identifies the producer: a snapshot replaces that scope's rows and
   * nothing else, and ids are namespaced under it. `label` titles the section on
   * screen. Returns false when there is no turn to report to — under plain pi,
   * or when called outside one — so a caller can tell "not shown" from "shown".
   */
  activity(events: unknown, options?: { scope?: string; label?: string }): boolean;
}

/** The sink of the turn on this call stack, if a turn owns it. */
const turnSink = new AsyncLocalStorage<(event: TaskActivityEvent) => void>();

/** Run `operation` as the turn that owns `sink`. Everything the turn reaches —
 *  pi's agent loop, extension handlers, tool executions — is inside it. */
export function runWithActivitySink<T>(sink: (event: TaskActivityEvent) => void, operation: () => T): T {
  return turnSink.run(sink, operation);
}

const host: ElevenHost = {
  version: 1,
  activity(events, options = {}) {
    const sink = turnSink.getStore();
    if (!sink) return false;
    const scope = options.scope?.trim() || options.label?.trim() || "extension";
    try {
      for (const event of normalizeActivity(events, scope, options.label?.trim())) sink(event);
    } catch (error) {
      // Reporting progress must never be able to fail whatever was reporting it.
      log.warn(`extension activity report failed: ${error}`);
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

import { randomUUID } from "node:crypto";
import type { BackgroundStatus, BackgroundStatusFactory } from "../agent/host-api.ts";

export const BACKGROUND_STOP_PREFIX = "eleven:bg:";

/** Buttons belong to one run in one conversation, never to its current turn. */
export class BackgroundStatuses {
  private readonly runs = new Map<string, { sessionKey: string; stop: () => void }>();

  create(sessionKey: string, options: Parameters<BackgroundStatusFactory>[0], render: (stopId: string) => BackgroundStatus): BackgroundStatus {
    const id = `${BACKGROUND_STOP_PREFIX}${randomUUID()}`;
    const status = render(id);
    this.runs.set(id, { sessionKey, stop: options.stop });
    return {
      panels: (update) => status.panels(update),
      finish: async (outcome) => {
        this.runs.delete(id);
        await status.finish(outcome);
      },
    };
  }

  stop(sessionKey: string, id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.sessionKey !== sessionKey) return false;
    run.stop();
    return true;
  }
}

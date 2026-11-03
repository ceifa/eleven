import { z } from "zod";
import { randomUUID } from "node:crypto";
import { PENDING_TURNS_FILE } from "../paths.ts";
import { readJsonFile, writeJsonFile } from "../util.ts";

const turnSchema = z.object({ threadId: z.string(), lastAliveAt: z.number() });
const replySchema = z.object({
  id: z.string(), sessionKey: z.string(), text: z.string(), replyTo: z.string().optional(),
  sentChunks: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(), nextAttemptAt: z.number(),
  error: z.string().optional(), blocked: z.boolean().optional(),
});
const stateSchema = z.object({ version: z.literal(1), turns: z.record(z.string(), turnSchema), replies: z.array(replySchema) });
export type PendingTurn = z.infer<typeof turnSchema>;
export type PendingReply = z.infer<typeof replySchema>;
type PendingState = z.infer<typeof stateSchema>;

/** The atomic handoff from interrupted generation to literal reply delivery. */
export class PendingTurns {
  private data: PendingState;
  private file: string;

  constructor(file = PENDING_TURNS_FILE) {
    this.file = file;
    const stored = readJsonFile<unknown>(file, {});
    this.data = stored && typeof stored === "object" && "version" in stored
      ? stateSchema.parse(stored)
      : { version: 1, turns: z.record(z.string(), turnSchema).parse(stored), replies: [] };
  }

  private change(update: (data: PendingState) => void) {
    const next = structuredClone(this.data);
    update(next);
    writeJsonFile(this.file, next);
    this.data = next;
  }

  begin(threadId: string, now = Date.now()) {
    this.change((data) => { data.turns[threadId] = { threadId, lastAliveAt: now }; });
  }

  beat(now = Date.now()) {
    if (!Object.keys(this.data.turns).length) return;
    this.change((data) => { for (const turn of Object.values(data.turns)) turn.lastAliveAt = now; });
  }

  end(threadId: string) {
    if (this.data.turns[threadId]) this.change((data) => { delete data.turns[threadId]; });
  }

  /** Commit before any send: restart must not ask the model to generate again. */
  complete(threadId: string, sessionKey: string, text: string, replyTo?: string) {
    this.change((data) => {
      if (text) data.replies.push({ id: randomUUID(), sessionKey, text, replyTo, sentChunks: 0, attempts: 0, nextAttemptAt: 0 });
      delete data.turns[threadId];
    });
  }

  replyStatus(sessionKey: string) {
    const replies = this.data.replies.filter((reply) => reply.sessionKey === sessionKey);
    if (!replies.length) return;
    return { pending: replies.filter((reply) => !reply.blocked).length, blocked: replies.filter((reply) => reply.blocked).length, error: replies.find((reply) => reply.error)?.error };
  }

  hasReply(sessionKey: string) {
    return this.data.replies.some((reply) => reply.sessionKey === sessionKey && !reply.blocked);
  }

  progress(id: string, sentChunks: number) {
    this.change((data) => {
      const reply = data.replies.find((entry) => entry.id === id);
      if (reply) reply.sentChunks = sentChunks;
    });
  }

  replies(): readonly PendingReply[] {
    return structuredClone(this.data.replies);
  }

  acknowledge(id: string) {
    this.change((data) => { data.replies = data.replies.filter((reply) => reply.id !== id); });
  }

  failed(id: string, error: string, blocked: boolean, now = Date.now()) {
    this.change((data) => {
      const reply = data.replies.find((entry) => entry.id === id);
      if (!reply) return;
      reply.attempts++;
      reply.error = error;
      reply.blocked = blocked;
      reply.nextAttemptAt = now + Math.min(300_000, 5000 * 2 ** Math.min(reply.attempts - 1, 6));
    });
  }

  drain(): PendingTurn[] {
    const turns = Object.values(this.data.turns);
    if (turns.length) this.change((data) => { data.turns = {}; });
    return turns;
  }
}

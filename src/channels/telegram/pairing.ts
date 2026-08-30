import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PAIRING_FILE } from "../../paths.ts";
import { debouncedWriter, readJsonFile, writeJsonFile } from "../../util.ts";

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PairingRequest {
  /** Internal identifier for approve/deny — never shown to the requester. */
  id: string;
  /** "dm": an unknown sender wants to talk. "group": the bot saw an unregistered group. */
  kind: "dm" | "group";
  bot: string;
  userId: number;
  chatId: number;
  chatTitle?: string;
  username?: string;
  name?: string;
  /** The name arrived dressed up in lookalike unicode (see `foldDisplayName`). */
  disguised?: boolean;
  /** Profile picture as a `data:` URL — small enough (Telegram's 160px thumb)
   *  to travel inside the record, which spares the dashboard an image route
   *  that would have to carry the bot token. */
  photo?: string;
  createdAt: number;
}

/** What makes two requests the same request: one pending entry per stranger. */
export type PairingIdentity = Pick<PairingRequest, "bot" | "kind" | "userId" | "chatId">;

/**
 * Deny-by-default with no id hunting: unknown DM senders and unregistered
 * groups surface as requests; approving one in the dashboard adds it to the
 * channel's allowlist/groups.
 */
export class PairingStore extends EventEmitter {
  private requests: PairingRequest[];

  constructor() {
    super();
    const stored = readJsonFile<{ requests: (PairingRequest & { code?: string })[] }>(PAIRING_FILE, { requests: [] });
    this.requests = stored.requests
      .filter((r) => Date.now() - r.createdAt < REQUEST_TTL_MS)
      .map((r) => ({ ...r, id: r.id ?? r.code ?? randomUUID().slice(0, 8) }));
  }

  /** The pending request for this stranger, if they already knocked. Callers use
   *  it to skip the work (a profile photo download) a duplicate would waste. */
  find(identity: PairingIdentity): PairingRequest | undefined {
    return this.requests.find(
      (r) =>
        r.bot === identity.bot &&
        (identity.kind === "group" ? r.kind === "group" && r.chatId === identity.chatId : r.kind === "dm" && r.userId === identity.userId),
    );
  }

  /** Register (or return the existing) request for an unknown sender or group. */
  request(input: Omit<PairingRequest, "id" | "createdAt">): { request: PairingRequest; isNew: boolean } {
    const existing = this.find(input);
    if (existing) return { request: existing, isNew: false };
    const request: PairingRequest = { ...input, id: randomUUID().slice(0, 8), createdAt: Date.now() };
    this.requests.push(request);
    this.persist();
    this.emit("request", request);
    return { request, isNew: true };
  }

  list(): PairingRequest[] {
    return [...this.requests];
  }

  /** Remove and return a request (after approval or denial). */
  take(id: string): PairingRequest | undefined {
    const index = this.requests.findIndex((r) => r.id === id);
    if (index === -1) return undefined;
    const [request] = this.requests.splice(index, 1);
    this.persist();
    return request;
  }

  private persist = debouncedWriter(() => writeJsonFile(PAIRING_FILE, { requests: this.requests }));
}

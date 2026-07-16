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
  createdAt: number;
}

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

  /** Register (or return the existing) request for an unknown sender or group. */
  request(input: Omit<PairingRequest, "id" | "createdAt">): { request: PairingRequest; isNew: boolean } {
    const existing = this.requests.find(
      (r) => r.bot === input.bot && (input.kind === "group" ? r.kind === "group" && r.chatId === input.chatId : r.kind === "dm" && r.userId === input.userId),
    );
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

import type { ConfigStore, ChannelType } from "../config.ts";
import type { Avatar } from "./avatars.ts";
import type { PairingRequest, PairingStore } from "./pairing.ts";

export interface ChannelStatus {
  type: ChannelType;
  name: string;
  username?: string;
  connected: boolean;
}

/** Where a literal delivery landed. */
export interface DeliveryTarget {
  channel: ChannelType;
  bot: string;
  chatId: number | string;
  topic?: number | string;
}

/** What the daemon and the dashboard need from a chat platform. Everything
 *  addressed by session key is only ever handed keys of the channel's own type. */
export interface Channel {
  readonly type: ChannelType;
  status(): ChannelStatus[];
  /** Deliver literal operator-authored prose to the conversation. */
  sendToSession(sessionKey: string, text: string): Promise<DeliveryTarget>;
  /** Drop input a conversation has buffered but not yet turned into a turn.
   *  Part of stopping from outside the chat: aborting the running turn alone
   *  would leave a pending burst free to start the next one. */
  discardPending(sessionKey: string): boolean;
  /** Re-prompt conversations a restart interrupted. */
  wakeInterrupted(turns: { sessionKey: string }[]): void;
  /** The picture the platform draws for a conversation it knows. */
  avatar(sessionKey: string): Promise<Avatar | undefined>;
  /** Tell an approved requester they're in. */
  welcome(request: PairingRequest): Promise<void>;
  stop(): Promise<void>;
}

/** Every channel eleven runs, behind one face: calls about a conversation go
 *  to the channel its session key names, and pairing is shared. */
export class Channels {
  readonly pairing: PairingStore;
  private config: ConfigStore;
  private list: Channel[];

  constructor(config: ConfigStore, pairing: PairingStore, list: Channel[]) {
    this.config = config;
    this.pairing = pairing;
    this.list = list;
  }

  private owner(sessionKey: string): Channel | undefined {
    const type = sessionKey.split(":", 1)[0];
    return this.list.find((channel) => channel.type === type);
  }

  status(): ChannelStatus[] {
    return this.list.flatMap((channel) => channel.status());
  }

  async sendToSession(sessionKey: string, text: string): Promise<DeliveryTarget> {
    const owner = this.owner(sessionKey);
    if (!owner) throw new Error("thread has no channel to deliver to");
    return owner.sendToSession(sessionKey, text);
  }

  discardPending(sessionKey: string): boolean {
    return this.owner(sessionKey)?.discardPending(sessionKey) ?? false;
  }

  wakeInterrupted(turns: { sessionKey: string }[]): void {
    for (const channel of this.list) {
      const own = turns.filter((turn) => this.owner(turn.sessionKey) === channel);
      if (own.length) channel.wakeInterrupted(own);
    }
  }

  async avatar(sessionKey: string): Promise<Avatar | undefined> {
    return this.owner(sessionKey)?.avatar(sessionKey);
  }

  /** Approve a pairing request: allowlist the user (dm) or register the group. */
  async approvePairing(id: string): Promise<PairingRequest> {
    const request = this.pairing.take(id);
    if (!request) throw new Error(`unknown pairing request ${id}`);

    const raw = structuredClone(this.config.raw);
    const channel = this.config.channels(raw).find((c) => c.channel.name === request.bot)?.channel;
    if (!channel) throw new Error(`channel ${request.bot} no longer configured`);

    if (request.kind === "dm") {
      channel.users = { ...channel.users, [request.userId]: { name: request.name, username: request.username } };
    } else {
      channel.groups = { ...channel.groups, [request.chatId]: { requireMention: false, title: request.chatTitle } };
    }
    this.config.save(raw);

    await this.list.find((c) => c.type === channel.type)?.welcome(request).catch(() => {});
    return request;
  }

  denyPairing(id: string): PairingRequest {
    const request = this.pairing.take(id);
    if (!request) throw new Error(`unknown pairing request ${id}`);
    return request;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.list.map((channel) => channel.stop()));
  }
}

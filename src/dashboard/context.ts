import type { ConfigStore } from "../config.ts";
import type { Gateway } from "../gateway.ts";
import type { Channels } from "../channels/index.ts";
import { conversationIdentity } from "../threads/conversation.ts";
import type { Broadcast } from "./broadcast.ts";

type ChannelConfig = ReturnType<ConfigStore["channels"]>[number]["channel"];

/** What the API handlers work with: the daemon's parts, and the feed to every
 *  open dashboard. */
export interface DashboardContext {
  config: ConfigStore;
  gateway: Gateway;
  channels: Channels;
  broadcast: Broadcast;
  /** Every configured channel, across workspaces. */
  channelConfigs(): ChannelConfig[];
  /** How a conversation is named and pictured, from its session key. */
  identityOf(sessionKey: string): ReturnType<typeof conversationIdentity>;
}

export function createContext(config: ConfigStore, gateway: Gateway, channels: Channels, broadcast: Broadcast): DashboardContext {
  // A list read resolves an identity per thread, and there are hundreds of
  // them — so the channel array is derived once per config generation instead
  // of being rebuilt for every single thread.
  const channelsByConfig = new WeakMap<object, ChannelConfig[]>();
  function channelConfigs() {
    const entries = config.channels();
    let list = channelsByConfig.get(entries);
    if (!list) {
      list = entries.map(({ channel }) => channel);
      channelsByConfig.set(entries, list);
    }
    return list;
  }
  const identityOf = (sessionKey: string) => conversationIdentity(sessionKey, channelConfigs());

  return { config, gateway, channels, broadcast, channelConfigs, identityOf };
}

import type { ConfigStore } from "../../config.ts";
import type { Gateway } from "../../gateway.ts";
import { BotChannel } from "../bots.ts";
import type { PairingStore } from "../pairing.ts";
import { canRetrySend } from "./api.ts";
import { startGoogleChatBot, type BotHandle } from "./bot.ts";

/** Google Chat, one HTTP endpoint per channel configured across workspaces. */
export class GoogleChatChannel extends BotChannel<BotHandle> {
  constructor(config: ConfigStore, gateway: Gateway, pairing: PairingStore) {
    super("googlechat", "Google Chat", config, { gateway, pairing }, startGoogleChatBot, canRetrySend);
  }
}

import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { logger } from "../log.ts";

const log = logger("pi");

export const agentDir = getAgentDir();
export const authStorage = AuthStorage.create();
export const modelRegistry = ModelRegistry.create(authStorage);

export function findModel(ref: string): Model<Api> | undefined {
  const slash = ref.indexOf("/");
  if (slash === -1) return undefined;
  return modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

export function modelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * pi gates project-local skills behind a per-directory trust prompt (interactive
 * in its TUI). eleven runs headless, so workspaces from eleven.json are trusted
 * explicitly at startup.
 */
export function trustWorkspaces(paths: string[]) {
  const store = new ProjectTrustStore(agentDir);
  for (const path of paths) {
    if (store.get(path) !== true) {
      store.set(path, true);
      log.info(`trusted workspace ${path}`);
    }
  }
}

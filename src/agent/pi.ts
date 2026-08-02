import {
  getAgentDir,
  ModelRuntime,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { logger } from "../log.ts";
import { claudeCodeProvider } from "./claude-code.ts";

const log = logger("pi");

export const agentDir = getAgentDir();

/**
 * pi folded AuthStorage and ModelRegistry into ModelRuntime, which owns
 * credentials, models.json and the dynamic provider catalogs. It is async, so
 * it is awaited here once at module scope — that keeps every call site below,
 * and every consumer of this module, synchronous. `create()` stays offline by
 * default so plain CLI commands don't wait on the network; the daemon calls
 * `refreshModelCatalogs()` after it is up.
 */
export const modelRuntime = await ModelRuntime.create();
// Claude Code is an ambient local runtime: it uses the official Agent SDK and
// the login managed by `claude auth login`, never Pi's Anthropic OAuth/API path.
modelRuntime.registerNativeProvider(claudeCodeProvider);

/** How often the daemon re-checks provider catalogs. pi throttles the actual
 * network calls to once per four hours per provider, so this is cheap. */
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

export function findModel(ref: string): Model<Api> | undefined {
  const slash = ref.indexOf("/");
  if (slash === -1) return undefined;
  return modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1));
}

export function modelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Keep the model catalog fresh while the daemon runs, so models released after
 * this eleven was installed become usable without an upgrade. Best-effort: on
 * failure the bundled/persisted catalog stays in place. Returns a stop handle.
 */
export function refreshModelCatalogs(): () => void {
  const refresh = async () => {
    try {
      const { aborted, errors } = await modelRuntime.refresh({ allowNetwork: true });
      if (aborted) return log.warn("model catalog refresh aborted");
      for (const [provider, error] of errors) log.warn(`model catalog refresh failed for ${provider}: ${error.message}`);
    } catch (error) {
      log.warn(`model catalog refresh failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), CATALOG_REFRESH_MS);
  return () => clearInterval(timer);
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

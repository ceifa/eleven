import { existsSync } from "node:fs";
import { Api } from "grammy";
import { ConfigStore, isUnresolved } from "./config.ts";
import { findModel, modelRuntime } from "./agent/pi.ts";
import { CONFIG_FILE } from "./paths.ts";

export async function runDoctor(): Promise<boolean> {
  let healthy = true;
  const check = (ok: boolean, label: string, detail?: string) => {
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) healthy = false;
  };

  const [major] = process.versions.node.split(".").map(Number);
  check(major >= 24, `node ${process.versions.node}`, major >= 24 ? undefined : "eleven needs node >= 24");

  let config: ConfigStore;
  try {
    config = new ConfigStore();
    check(true, `config ${CONFIG_FILE}`);
  } catch (error) {
    check(false, `config ${CONFIG_FILE}`, String(error));
    return false;
  }

  const { workspaces, providers } = config.resolved;

  if (!providers.defaultModel) check(false, "model", "providers.defaultModel is empty");
  for (const ref of config.configuredModelRefs()) {
    const model = findModel(ref);
    if (!model) {
      check(false, `model ${ref}`, "not in pi's registry");
      continue;
    }
    const authed = modelRuntime.hasConfiguredAuth(model.provider);
    check(authed, `model ${ref}`, authed ? undefined : "no auth — run `pi /login` or set the provider API key");
  }

  check(Object.keys(workspaces).length > 0, "workspaces", Object.keys(workspaces).length ? undefined : "none configured");
  for (const [name, workspace] of Object.entries(workspaces)) {
    check(existsSync(workspace.path), `workspace ${name}`, existsSync(workspace.path) ? workspace.path : `missing directory ${workspace.path}`);
  }

  for (const { workspace, channel } of config.channels()) {
    const label = `channel ${channel.name} (${channel.type} → ${workspace})`;
    if (isUnresolved(channel.token)) {
      check(false, label, `token unresolved (${channel.token || "empty"})`);
      continue;
    }
    try {
      const me = await new Api(channel.token).getMe();
      check(true, label, `@${me.username}`);
    } catch (error) {
      check(false, label, `getMe failed: ${error}`);
    }
  }

  console.log(healthy ? "\nall good" : "\nissues found");
  return healthy;
}

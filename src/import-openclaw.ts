import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type ChannelConfig, type ElevenConfig } from "./config.ts";
import { findModel } from "./agent/pi.ts";
import { CONFIG_FILE } from "./paths.ts";

/**
 * One-shot config migration from an OpenClaw install (~/.openclaw). Brings over
 * the Telegram bot (token, DM/group allowlists, groups), model preferences and
 * voice transcription. Credentials are NOT copied — pi has its own auth
 * (~/.pi/agent/auth.json, `pi /login`).
 */
export async function importOpenclaw() {
  const openclawFile = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(openclawFile)) {
    console.error(`no OpenClaw config at ${openclawFile}`);
    process.exitCode = 1;
    return;
  }
  const openclaw = JSON.parse(readFileSync(openclawFile, "utf8"));
  const store = new ConfigStore();
  const config: ElevenConfig = structuredClone(store.raw);

  // Model mapping: OpenClaw's "openai" provider is ChatGPT OAuth, which pi calls
  // "openai-codex". Anything else passes through and is validated against pi's registry.
  const mapModel = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    const mapped = ref.startsWith("openai/") ? ref.replace("openai/", "openai-codex/") : ref;
    if (!findModel(mapped)) console.warn(`  ! model ${mapped} not found in pi's registry (kept anyway)`);
    return mapped;
  };

  const defaults = openclaw.agents?.defaults ?? {};
  const refs = [defaults.model?.primary, ...(defaults.model?.fallbacks ?? [])]
    .map(mapModel)
    .filter((ref): ref is string => !!ref);
  if (refs.length) {
    config.models = [...new Set(refs)].map((model) =>
      defaults.thinkingDefault ? { model, reasoning: defaults.thinkingDefault } : { model },
    );
  }

  const telegram = openclaw.channels?.telegram;
  if (telegram?.botToken) {
    const dmAllow = readAllowFrom(join(homedir(), ".openclaw", "credentials", "telegram-default-allowFrom.json"));
    const channel: ChannelConfig = {
      type: "telegram",
      name: "main",
      token: telegram.botToken,
      users: Object.fromEntries(dmAllow.map((id) => [String(id), {}])),
      groupAllowedUsers: (telegram.groupAllowFrom ?? []).map(Number).filter(Number.isFinite),
      groups: Object.fromEntries(
        Object.entries(telegram.groups ?? {}).map(([id, group]) => [
          id,
          { requireMention: (group as { requireMention?: boolean }).requireMention },
        ]),
      ),
    };
    // Channels live inside a workspace; attach to the first one (or a placeholder to fill in).
    let workspace = Object.keys(config.workspaces)[0];
    if (!workspace) {
      workspace = "main";
      config.workspaces.main = { path: "~" };
      console.warn('  ! created placeholder workspace "main" with path "~" — point it at a real directory');
    }
    const channels = (config.workspaces[workspace].channels ??= []);
    const existing = channels.findIndex((c) => c.name === channel.name);
    if (existing >= 0) channels[existing] = channel;
    else channels.push(channel);
    console.log(`  telegram channel "main" → workspace "${workspace}": ${dmAllow.length} DM user(s), ${Object.keys(channel.groups ?? {}).length} group(s)`);
  }

  const audioModel = openclaw.tools?.media?.audio?.models?.[0];
  if (audioModel?.type === "cli" && Array.isArray(audioModel.args)) {
    const script = audioModel.args[audioModel.args.length - 1];
    if (typeof script === "string" && script.includes("{{MediaPath}}")) {
      config.transcription = { command: script.replaceAll("{{MediaPath}}", "{{file}}") };
      console.log("  voice transcription command imported");
    }
  }

  const idleMinutes = openclaw.session?.resetByType?.direct?.idleMinutes;
  // Merge, don't replace — a bare assignment would drop an existing retentionDays.
  if (typeof idleMinutes === "number") config.session = { ...config.session, idleDays: Math.max(1, Math.round(idleMinutes / 1440)) };

  store.save(config);
  console.log(`\nwrote ${CONFIG_FILE}`);
  console.log("note: review workspaces in the dashboard, then run `eleven doctor`.");
}

function readAllowFrom(file: string): number[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return (parsed.allowFrom ?? []).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { CONFIG_FILE, expandHome } from "./paths.ts";
import { writeJsonFile } from "./util.ts";

/** The pi built-in tools eleven's per-workspace policy can allow. Single source
 * of truth — the runner filters against it and the dashboard renders it. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

/** Channel types eleven can speak. Telegram today; the config shape is ready for more. */
export const CHANNEL_TYPES = ["telegram"] as const;

/** A "$VAR" value whose variable wasn't found in the environment. */
export function isUnresolved(value: string | undefined): boolean {
  return !value || value.startsWith("$");
}

export interface TopicConfig {
  title?: string;
  /** Extra instructions appended to this topic's system prompt. */
  appendSystemPrompt?: string;
}

export interface GroupConfig {
  requireMention?: boolean;
  title?: string;
  /** Extra instructions appended to this group's system prompt. */
  appendSystemPrompt?: string;
  /** Forum topics, keyed by topic id. Each topic is its own thread/session. */
  topics?: Record<string, TopicConfig>;
}

export interface UserConfig {
  /** Display name — self-heals from live traffic, like group titles. */
  name?: string;
  username?: string;
  /** Extra instructions appended to this user's DM system prompt. */
  appendSystemPrompt?: string;
}

export interface ChannelConfig {
  type: (typeof CHANNEL_TYPES)[number];
  /** Unique across all workspaces — it names the bot inside thread session keys. */
  name: string;
  token: string;
  /** Users allowed to DM, keyed by numeric id. Deny by default; grown via pairing. */
  users?: Record<string, UserConfig>;
  /** Group chats the channel participates in, keyed by chat id. Grown via pairing. */
  groups?: Record<string, GroupConfig>;
  /** Numeric user ids listened to inside groups (falls back to the DM users). */
  groupAllowedUsers?: number[];
}

export interface WorkspaceConfig {
  path: string;
  /** Allowlist from BUILTIN_TOOLS (read, bash, edit, write). Omit to allow all. */
  tools?: string[];
  /** Model override for this workspace, e.g. "openai-codex/gpt-5.5". */
  model?: string;
  /** Custom personality/style block; omit to use the built-in gateway prompt. */
  systemPrompt?: string;
  /** Chat channels routed to this workspace. */
  channels?: ChannelConfig[];
}

export interface ElevenConfig {
  dashboard: { port: number; host: string };
  providers: {
    defaultModel: string;
    fallbackModels: string[];
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  workspaces: Record<string, WorkspaceConfig>;
  /** Shell command that prints a transcript for {{file}} (voice messages). */
  transcription?: { command: string };
  session?: {
    /** Days a conversation may idle before it gets a fresh thread (default 7). */
    idleDays?: number;
    /** Days thread files (pi sessions + request logs) are kept on disk (default 30). */
    retentionDays?: number;
  };
}

export const DEFAULT_CONFIG: ElevenConfig = {
  dashboard: { port: 1111, host: "127.0.0.1" },
  providers: { defaultModel: "", fallbackModels: [] },
  workspaces: {},
};

/** Values like "$TELEGRAM_BOT_TOKEN" are resolved from the environment at load time. */
function interpolate(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return process.env[value.slice(1)] ?? value;
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

/** raw → resolved: env references and ~ in workspace paths. */
function resolve(raw: ElevenConfig): ElevenConfig {
  const resolved = interpolate(raw) as ElevenConfig;
  for (const workspace of Object.values(resolved.workspaces)) {
    workspace.path = expandHome(workspace.path);
  }
  return resolved;
}

export class ConfigStore extends EventEmitter {
  /** Config as written on disk ($VAR references intact) — what the dashboard edits. */
  raw: ElevenConfig;
  /** Config with environment references resolved — what the daemon consumes. */
  resolved: ElevenConfig;

  constructor() {
    super();
    this.raw = load();
    this.resolved = resolve(this.raw);
  }

  // Keyed on the config object itself: saves swap in fresh objects, so
  // invalidation is structural. Channels get looked up per message.
  private channelLists = new WeakMap<ElevenConfig, { workspace: string; channel: ChannelConfig }[]>();

  save(next: ElevenConfig) {
    validate(next);
    this.raw = next;
    this.resolved = resolve(next);
    writeJsonFile(CONFIG_FILE, next);
    this.emit("change", this.resolved);
  }

  /** All channels across workspaces, each with the workspace it routes to. */
  channels(config: ElevenConfig = this.resolved): { workspace: string; channel: ChannelConfig }[] {
    let list = this.channelLists.get(config);
    if (!list) {
      list = Object.entries(config.workspaces).flatMap(([workspace, w]) =>
        (w.channels ?? []).map((channel) => ({ workspace, channel })),
      );
      this.channelLists.set(config, list);
    }
    return list;
  }

  /** Ordered model candidates for a turn: override → workspace → default, then fallbacks. */
  modelCandidates(threadModel?: string, workspaceModel?: string): string[] {
    const { defaultModel, fallbackModels } = this.resolved.providers;
    return [...new Set([threadModel ?? workspaceModel ?? defaultModel, ...fallbackModels])].filter(Boolean);
  }

  /** Every model reference the config mentions (doctor validates all of them). */
  configuredModelRefs(): string[] {
    const { providers, workspaces } = this.resolved;
    const refs = [providers.defaultModel, ...providers.fallbackModels, ...Object.values(workspaces).map((w) => w.model)];
    return [...new Set(refs.filter((r): r is string => !!r))];
  }
}

function load(): ElevenConfig {
  let parsed: ElevenConfig;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Could not parse ${CONFIG_FILE}: ${error}`);
  }
  // Spread merges only the top level, so a partial "dashboard"/"providers" object
  // in a hand-edited file would drop the sibling defaults (e.g. host, or the
  // fallbackModels array modelCandidates() iterates). Merge those nested objects.
  const defaults = structuredClone(DEFAULT_CONFIG);
  const config: ElevenConfig = {
    ...defaults,
    ...parsed,
    dashboard: { ...defaults.dashboard, ...parsed.dashboard },
    providers: { ...defaults.providers, ...parsed.providers },
  };
  validate(config);
  return config;
}

export function validate(config: ElevenConfig) {
  const seen = new Set<string>();
  for (const [workspace, w] of Object.entries(config.workspaces)) {
    for (const channel of w.channels ?? []) {
      if (!(CHANNEL_TYPES as readonly string[]).includes(channel.type)) {
        throw new Error(`workspace "${workspace}": unknown channel type "${channel.type}"`);
      }
      if (!channel.name) throw new Error(`workspace "${workspace}": channel needs a name`);
      if (seen.has(channel.name)) throw new Error(`duplicate channel name "${channel.name}" — names identify threads and must be unique`);
      seen.add(channel.name);
      if (!channel.token) throw new Error(`channel "${channel.name}" has no token`);
    }
  }
  if (!Number.isInteger(config.dashboard.port) || config.dashboard.port < 1 || config.dashboard.port > 65535) {
    throw new Error(`invalid dashboard port: ${config.dashboard.port}`);
  }
}

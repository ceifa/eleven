import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { CONFIG_FILE, expandHome } from "./paths.ts";
import { writeJsonFile } from "./util.ts";

/** Provider-neutral workspace capabilities. Pi consumes the four core tools;
 * Claude Code additionally understands web and native subagents. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "web", "agent"] as const;
export type WorkspaceTool = (typeof BUILTIN_TOOLS)[number];

/** The subset implemented by Pi itself. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
/** What a ModelEntry without an explicit reasoning level runs at. The daemon
 * and the dashboard both take it from here (served via /api/overview). */
export const DEFAULT_REASONING: ReasoningLevel = "high";

/** Every capability a model's runtime can offer. The UI narrows this further
 * per catalog entry; the daemon treats unsupported names as simply inactive. */
export function runtimeTools(provider: string): readonly WorkspaceTool[] {
  return provider === "claude-code" ? BUILTIN_TOOLS : PI_BUILTIN_TOOLS;
}

/** Channel types eleven can speak. Telegram today; the config shape is ready for more. */
export const CHANNEL_TYPES = ["telegram"] as const;

/** A "$VAR" value whose variable wasn't found in the environment. */
export function isUnresolved(value: string | undefined): boolean {
  return !value || value.startsWith("$");
}

/** What any scope (workspace, group, topic) may say about models: its own
 * sequence, replacing the inherited one outright. */
export interface ModelScope {
  models?: ModelEntry[];
}

export interface TopicConfig extends ModelScope {
  title?: string;
  /** Extra instructions appended to this topic's system prompt. */
  appendSystemPrompt?: string;
}

export interface GroupConfig extends ModelScope {
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

export interface WorkspaceConfig extends ModelScope {
  path: string;
  /** Provider-neutral capability allowlist. Omit for the curated full set. */
  tools?: WorkspaceTool[];
  /** Custom personality/style block; omit to use the built-in gateway prompt. */
  systemPrompt?: string;
  /** Chat channels routed to this workspace. */
  channels?: ChannelConfig[];
}

/** One step of the model sequence: the ref plus how it should run. */
export interface ModelEntry {
  /** "provider/model-id" from pi's registry ("claude-code/…" for the native runtime). */
  model: string;
  /** Thinking level while this model drives a turn (default "high"). */
  reasoning?: ReasoningLevel;
  /** Capability allowlist while this model drives a turn; omit for everything
   * its runtime supports. Always intersected with the workspace's own tools. */
  tools?: WorkspaceTool[];
}

export interface ElevenConfig {
  dashboard: { port: number; host: string };
  /** Ordered model sequence: the first entry leads every turn, the rest are
   * fallbacks tried in order when it fails. */
  models: ModelEntry[];
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
  models: [],
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

  /**
   * Ordered model plan for a turn. Scopes go most-specific first (topic →
   * group → workspace); the first one carrying its own `models` sequence
   * replaces the global one outright. A thread's model override is promoted
   * to the front — matching a sequence entry adopts its reasoning/tools, an
   * unknown ref runs with defaults.
   */
  turnModels(threadModel?: string, scopes: (ModelScope | undefined)[] = []): ModelEntry[] {
    const sequence = scopes.find((scope) => scope?.models?.length)?.models ?? this.resolved.models;
    const plan: ModelEntry[] = [];
    const seen = new Set<string>();
    const push = (entry: ModelEntry) => {
      if (!entry.model || seen.has(entry.model)) return;
      seen.add(entry.model);
      plan.push(entry);
    };
    if (threadModel) push(sequence.find((entry) => entry.model === threadModel) ?? { model: threadModel });
    for (const entry of sequence) push(entry);
    return plan;
  }

  /** Every model reference the config mentions (doctor validates all of them). */
  configuredModelRefs(): string[] {
    const { models, workspaces } = this.resolved;
    const scopeRefs = (scope: ModelScope) => (scope.models ?? []).map((entry) => entry.model);
    const refs = [
      ...models.map((entry) => entry.model),
      ...Object.values(workspaces).flatMap((w) => [
        ...scopeRefs(w),
        ...(w.channels ?? []).flatMap((channel) =>
          Object.values(channel.groups ?? {}).flatMap((group) => [
            ...scopeRefs(group),
            ...Object.values(group.topics ?? {}).flatMap((topic) => scopeRefs(topic)),
          ]),
        ),
      ]),
    ];
    return [...new Set(refs.filter(Boolean))];
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
  // Spread merges only the top level, so a partial "dashboard" object in a
  // hand-edited file would drop the sibling defaults (e.g. host). Merge it.
  const defaults = structuredClone(DEFAULT_CONFIG);
  const config: ElevenConfig = {
    ...defaults,
    ...parsed,
    dashboard: { ...defaults.dashboard, ...parsed.dashboard },
    models: parsed.models ?? [],
  };
  validate(config);
  return config;
}

function validateTools(tools: WorkspaceTool[] | undefined, where: string) {
  for (const tool of tools ?? []) {
    if (!(BUILTIN_TOOLS as readonly string[]).includes(tool)) {
      throw new Error(`${where}: unknown tool capability "${tool}"`);
    }
  }
}

function validateSequence(entries: ModelEntry[] | undefined, where: string) {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw new Error(`${where}: models must be an array`);
  entries.forEach((entry, index) => {
    const label = `${where}[${index}]`;
    if (!entry.model || typeof entry.model !== "string") throw new Error(`${label}: missing model reference`);
    if (!entry.model.includes("/")) throw new Error(`${label}: "${entry.model}" is not a provider/model reference`);
    if (entry.reasoning && !(REASONING_LEVELS as readonly string[]).includes(entry.reasoning)) {
      throw new Error(`${label}: unknown reasoning level "${entry.reasoning}"`);
    }
    validateTools(entry.tools, label);
  });
}

export function validate(config: ElevenConfig) {
  validateSequence(config.models ?? [], "models");
  const seen = new Set<string>();
  for (const [workspace, w] of Object.entries(config.workspaces)) {
    validateSequence(w.models, `workspace "${workspace}" models`);
    validateTools(w.tools, `workspace "${workspace}"`);
    for (const channel of w.channels ?? []) {
      for (const group of Object.values(channel.groups ?? {})) {
        validateSequence(group.models, `group "${group.title ?? "?"}" models`);
        for (const topic of Object.values(group.topics ?? {})) {
          validateSequence(topic.models, `topic "${topic.title ?? "?"}" models`);
        }
      }
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

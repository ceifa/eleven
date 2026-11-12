import { existsSync } from "node:fs";
import { BUILTIN_TOOLS, CHANNEL_TYPES, DEFAULT_REASONING, isUnresolved, REASONING_LEVELS, validate, type ElevenConfig } from "../../config.ts";
import { BUILTIN_SYSTEM_PROMPT } from "../../agent/system-prompt.ts";
import { listWorkspaceSkills } from "../../agent/skills.ts";
import type { DashboardContext } from "../context.ts";
import { ApiError, body } from "../http.ts";
import type { Route } from "../router.ts";

/** The daemon at a glance, its config, and the workspaces in it. */
export function configRoutes({ config, gateway, channels }: DashboardContext): Route[] {
  async function workspaceView(name: string, includeSkills: boolean) {
    const workspace = config.resolved.workspaces[name];
    if (!workspace) throw new ApiError(404, `workspace ${name} not found`);
    const bots = new Map(channels.status().map((bot) => [bot.name, bot]));
    const threads = gateway.threads.list(name);
    const channelViews = (workspace.channels ?? []).map((channel) => {
      const bot = bots.get(channel.name);
      return {
        type: channel.type,
        name: channel.name,
        username: bot?.username,
        connected: bot?.connected ?? false,
        users: Object.keys(channel.users ?? {}).length,
        groups: Object.keys(channel.groups ?? {}).length,
      };
    });
    const chain = config.turnModels(undefined, [workspace]);
    const result = {
      name,
      path: workspace.path,
      pathExists: existsSync(workspace.path),
      model: chain[0]?.model ?? "",
      modelSource: workspace.models?.length ? "workspace" : "inherited",
      fallbacks: chain.slice(1).map((entry) => entry.model),
      tools: workspace.tools ?? [...BUILTIN_TOOLS],
      customPrompt: workspace.systemPrompt !== undefined,
      channels: channelViews,
      threads: {
        total: threads.length,
        current: threads.filter((thread) => gateway.threads.isCurrent(thread.id)).length,
        running: threads.filter((thread) => gateway.isThreadRunning(thread.id)).length,
      },
      session: {
        idleDays: config.resolved.session?.idleDays ?? 7,
        retentionDays: config.resolved.session?.retentionDays ?? 30,
      },
    };
    if (!includeSkills) return result;
    const skills = existsSync(workspace.path) ? await listWorkspaceSkills(workspace.path) : [];
    return { ...result, skills: skills.map(({ name, description }) => ({ name, description })) };
  }

  return [
    {
      method: "GET",
      pattern: "/status",
      handler({ send }) {
        const bots = channels.status();
        const configuredChannels = config.channels();
        const healthyNames = new Set(bots.filter((bot) => bot.connected).map((bot) => bot.name));
        const threads = gateway.threads.list();
        return send(200, {
          service: "running",
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          dashboard: config.resolved.dashboard,
          workspaces: Object.keys(config.resolved.workspaces).length,
          channels: {
            total: configuredChannels.length,
            healthy: configuredChannels.filter(({ channel }) => healthyNames.has(channel.name)).length,
          },
          threads: {
            total: threads.length,
            current: threads.filter((thread) => gateway.threads.isCurrent(thread.id)).length,
            running: threads.filter((thread) => gateway.isThreadRunning(thread.id)).length,
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "/workspaces",
      async handler({ send }) {
        return send(200, await Promise.all(Object.keys(config.resolved.workspaces).map((name) => workspaceView(name, false))));
      },
    },
    {
      method: "GET",
      pattern: "/workspaces/:name",
      async handler({ params, send }) {
        return send(200, await workspaceView(decodeURIComponent(params.name), true));
      },
    },
    {
      method: "GET",
      pattern: "/overview",
      handler({ send }) {
        return send(200, {
          bots: channels.status(),
          pairing: channels.pairing.list(),
          // Names only: the pages that edit a workspace read /config for it,
          // and the ones that merely offer a choice (the filter, the new-thread
          // dialog) never needed anything else.
          workspaces: Object.keys(config.resolved.workspaces),
          tools: BUILTIN_TOOLS,
          reasoningLevels: REASONING_LEVELS,
          defaultReasoning: DEFAULT_REASONING,
          channelTypes: CHANNEL_TYPES,
          builtinSystemPrompt: BUILTIN_SYSTEM_PROMPT,
        });
      },
    },
    {
      method: "GET",
      pattern: "/config",
      handler({ send }) {
        return send(200, redactTokens(config.raw));
      },
    },
    {
      method: "PUT",
      pattern: "/config",
      async handler({ req, send }) {
        const next = (await body(req)) as ElevenConfig;
        try {
          restoreTokens(next, config.raw);
          validate(next);
        } catch (error) {
          // A config missing a whole section fails as a property read, not as
          // one of validate's own refusals — and it is still the request's fault.
          if (error instanceof TypeError) throw new ApiError(400, `malformed config: ${error.message}`);
          throw error;
        }
        config.save(next);
        return send(200, redactTokens(config.raw));
      },
    },
  ];
}

// The dashboard is reachable over a tunnel, so it must never receive real
// channel tokens — echoing them on every read is a needless exposure. Env
// references ($VAR) aren't secrets (just names), so they stay visible; only
// literal tokens are masked.
const SECRET_MASK = "••••••••";

function redactTokens(config: ElevenConfig): ElevenConfig {
  const clone = structuredClone(config);
  for (const workspace of Object.values(clone.workspaces))
    for (const channel of workspace.channels ?? [])
      if (!isUnresolved(channel.token)) channel.token = SECRET_MASK;
  return clone;
}

// The client edits the redacted config and PUTs it back, so a masked token
// means "unchanged" — restore it from disk. Lookup stays inside the same
// workspace: by name first, then by position, so a renamed channel keeps its
// token. A mask that matches nothing is rejected — persisting the mask
// literal as the token would silently break the channel.
function restoreTokens(next: ElevenConfig, current: ElevenConfig): void {
  for (const [name, workspace] of Object.entries(next.workspaces)) {
    const existing = current.workspaces[name]?.channels ?? [];
    (workspace.channels ?? []).forEach((channel, index) => {
      if (channel.token !== SECRET_MASK) return;
      const stored = existing.find((c) => c.name === channel.name) ?? existing[index];
      if (!stored) throw new Error(`channel "${channel.name}" has a masked token with no stored value — enter the real token`);
      channel.token = stored.token;
    });
  }
}

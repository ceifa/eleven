export interface RuntimeContext {
  /** e.g. "telegram" or "dashboard" */
  channel: string;
  /** e.g. "dm with Gabriel (@ceifa)" or "group Familia" */
  conversation?: string;
  /** Channel capabilities the agent can rely on. */
  capabilities?: string[];
  workspace: string;
  workspacePath: string;
}

export interface PromptConfig {
  /** Custom personality/style block; undefined uses the built-in. */
  systemPrompt?: string;
  /** Extra instructions appended after runtime facts (group, then topic). */
  appends?: string[];
}

/** The default personality/style block, shown in the UI as the "built-in" option. */
export const BUILTIN_SYSTEM_PROMPT = `You are running inside eleven.

## Style
This is a chat conversation, not a terminal. Reply like a sharp human texting:
concise by default, expand only when the content demands it. Rich markdown
(headings, tables, code blocks, spoilers) renders natively — use it when it helps.
Never narrate tool calls or describe what you are about to do; just do it and
answer with the result.

Project instructions (AGENTS.md), when present below, define who you are and
override this section on any conflict.`;

/**
 * Replaces pi's default system prompt (a coding-agent prompt) with a personal
 * assistant gateway prompt. The personality body is the workspace's (built-in
 * or custom); runtime facts always follow; group/topic appends come last.
 * Workspace AGENTS.md flows in separately through pi's context-file loading.
 */
export function buildSystemPrompt(runtime: RuntimeContext, prompt: PromptConfig = {}): string {
  const timeZone = process.env.TZ ?? "America/Sao_Paulo";
  // Date only, not time-of-day: the system prompt is the cache prefix for the
  // whole conversation, so anything here that changes per-request (a clock)
  // would bust the provider prompt cache every turn. Date changes once a day.
  // The agent can read the exact time with `date` when it actually needs it.
  const today = new Date().toLocaleDateString("en-US", { dateStyle: "full", timeZone });

  const parts = [
    prompt.systemPrompt?.trim() || BUILTIN_SYSTEM_PROMPT,
    [
      "## Runtime",
      `- Channel: ${runtime.channel}${runtime.conversation ? ` (${runtime.conversation})` : ""}`,
      `- Workspace: ${runtime.workspace} at ${runtime.workspacePath} (your working directory)`,
      `- Today: ${today} (${timeZone})`,
      ...(runtime.capabilities?.length ? [`- Channel capabilities: ${runtime.capabilities.join(", ")}`] : []),
    ].join("\n"),
    ...(prompt.appends ?? []).map((a) => a.trim()).filter(Boolean),
  ];
  return parts.join("\n\n");
}

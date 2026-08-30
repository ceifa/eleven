import { BUILTIN_TOOLS, type WorkspaceTool } from "../config.ts";

/**
 * Workspace capability -> pi tool names, the mirror of POLICY_TO_NATIVE on the
 * Claude side. pi ships grep/find/ls for its read-only preset — a session with
 * no bash to run them with — and powershell for Windows shells, so each answers
 * to the capability of the tool it stands in for. `web` and `agent` have no pi
 * equivalent and simply gate nothing there.
 */
const POLICY_TO_PI: Record<WorkspaceTool, readonly string[]> = {
  read: ["read", "grep", "find", "ls"],
  bash: ["bash", "powershell"],
  edit: ["edit"],
  write: ["write"],
  web: [],
  agent: [],
};

/**
 * The tools eleven itself brings to a pi session: workspace extension tools and
 * channel-provided custom tools. Everything else in the session registry is a
 * pi builtin, including the ones pi registers but deliberately leaves inactive,
 * so this must never be derived from the registry.
 */
export function elevenOwnedTools(extensionToolNames: string[], customToolNames: string[]): string[] {
  return [...new Set([...extensionToolNames, ...customToolNames])];
}

/**
 * The active tool set for a turn: every eleven-owned tool, plus the pi builtins
 * pi already had active that the policy still allows. Policy only ever removes
 * — a builtin pi left inactive stays inactive.
 */
export function activeToolNames(
  piActive: string[],
  owned: string[],
  policy: WorkspaceTool[] | undefined,
): string[] {
  const ownedSet = new Set(owned);
  const allowed = new Set((policy ?? BUILTIN_TOOLS).flatMap((tool) => POLICY_TO_PI[tool] ?? []));
  return [...new Set([...piActive, ...owned])].filter((name) => ownedSet.has(name) || allowed.has(name));
}

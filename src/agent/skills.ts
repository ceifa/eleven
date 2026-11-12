import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../log.ts";
import { agentDir } from "./pi.ts";

const log = logger("runner");

/** The skills a turn in this workspace would load — same discovery as runTurn. */
export async function listWorkspaceSkills(workspacePath: string): Promise<{ name: string; description: string }[]> {
  const loader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager: SettingsManager.create(workspacePath, agentDir),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: workspaceResources(workspacePath).skillDirs,
  });
  await loader.reload();
  return loader
    .getSkills()
    .skills.map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface WorkspaceResources {
  /** Nested `.agents/skills` dirs — pi only discovers cwd + ancestors. */
  skillDirs: string[];
}

const resourceCache = new Map<string, { resources: WorkspaceResources; at: number }>();
const RESOURCE_CACHE_MS = 60_000;

/**
 * pi discovers `.agents/skills` only in cwd and its ancestors. Monorepo
 * workspaces keep skill packs in nested context directories — surface them.
 * (Nested AGENTS.md are the agent's own job: the workspace's root AGENTS.md
 * instructs it to read the closest one before working in a context.)
 * The walk is sync and sits on the message hot path, so results are cached.
 */
export function workspaceResources(root: string, depth = 3): WorkspaceResources {
  const cached = resourceCache.get(root);
  if (cached && Date.now() - cached.at < RESOURCE_CACHE_MS) return cached.resources;
  const resources: WorkspaceResources = { skillDirs: [] };
  const walk = (dir: string, level: number) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // A directory we cannot enumerate drops every skill pack beneath it, and
      // the result is cached — so the loss outlives the fault while `/skills`
      // just looks short. Say so instead of pretending the subtree is empty.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`skill scan: cannot enumerate ${dir} — skills below it are missing: ${error}`);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(child))) continue;
      const skills = join(child, ".agents", "skills");
      if (existsSync(skills)) resources.skillDirs.push(skills);
      walk(child, level + 1);
    }
  };
  walk(root, 1);
  resourceCache.set(root, { resources, at: Date.now() });
  return resources;
}

/** Follows symlinks; stat is far cheaper than listing the directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

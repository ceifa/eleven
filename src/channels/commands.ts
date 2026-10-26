import type { Gateway } from "../gateway.ts";
import type { logger } from "../log.ts";

/** The commands every channel answers itself instead of passing to the agent
 *  (and registers in its client's "/" menu). */
export const COMMANDS = [
  { command: "new", description: "Start a fresh thread" },
  { command: "skills", description: "List the skills the agent can use here" },
  { command: "usage", description: "Show model subscription usage" },
  { command: "stop", description: "Abort the running turn" },
] as const;

export interface CommandContext {
  gateway: Gateway;
  sessionKey: string;
  workspace?: string;
  /** Drop the conversation's buffered input; true when there was some. */
  discardBurst: () => boolean;
  log: ReturnType<typeof logger>;
}

/** Run one of COMMANDS, returning the markdown to answer with — undefined for
 *  anything else, which goes to the agent as text. */
export async function runCommand(name: string, ctx: CommandContext): Promise<string | undefined> {
  const { gateway, sessionKey } = ctx;
  switch (name) {
    case "new": {
      // Fresh means fresh: drop buffered input and abort the in-flight turn,
      // so neither bleeds into (or races) the new conversation.
      ctx.discardBurst();
      await gateway.interrupt(sessionKey);
      gateway.newThread(sessionKey, ctx.workspace);
      return "🧵 Fresh thread started.";
    }
    case "skills": {
      const { workspace, skills } = await gateway.listSkills(sessionKey, ctx.workspace);
      if (!skills.length) return `No skills loaded for **${workspace}**.`;
      const lines = skills.map((s) => `- \`${s.name}\` — ${s.description.length > 90 ? `${s.description.slice(0, 90)}…` : s.description}`);
      return `**${skills.length} skills** loaded for **${workspace}**:\n${lines.join("\n")}`;
    }
    case "usage": {
      try {
        return await gateway.providerUsage();
      } catch (error) {
        ctx.log.warn(`usage lookup failed: ${error}`);
        return `⚠️ ${error instanceof Error ? error.message : error}`;
      }
    }
    case "stop": {
      const dropped = ctx.discardBurst();
      const stopped = await gateway.interrupt(sessionKey);
      return stopped || dropped ? "⏹ Stopped." : "Nothing running.";
    }
    default:
      return undefined;
  }
}

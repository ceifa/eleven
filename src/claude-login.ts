import { spawn } from "node:child_process";
import { claudeAccountDir } from "./agent/claude-code.ts";
import { CLAUDE_ACCOUNT_NAME } from "./config.ts";

/** Run Claude Code's own login inside the account's config dir, so a model
 * entry with `"account": "<name>"` runs on it. */
export async function claudeLogin(account: string | undefined): Promise<number> {
  if (!account || !CLAUDE_ACCOUNT_NAME.test(account)) {
    console.error("usage: eleven claude-login <account>  (letters, digits, - and _)");
    return 1;
  }
  const dir = claudeAccountDir(account);
  const child = spawn("claude", ["auth", "login"], { stdio: "inherit", env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`could not run \`claude\`: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code === 0) console.log(`signed in — use it with { "model": "claude-code/<model>", "account": "${account}" }`);
  return code;
}

import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { runOnAccount } from "./accounts.ts";
import { claudeAccountDir, CLAUDE_CODE_PROVIDER } from "./agent/claude-code.ts";
import { modelRuntime } from "./agent/pi.ts";
import { ACCOUNT_NAME } from "./config.ts";

/** Sign one more login of a provider in, under an account name model entries
 * can point at. Claude Code owns its login, so it runs the CLI's own; every
 * other provider goes through pi's login, stored in the account's auth.json. */
export async function login(provider: string | undefined, account: string | undefined): Promise<number> {
  if (!provider || !account || !ACCOUNT_NAME.test(account)) {
    console.error("usage: eleven login <provider> <account>  (account: letters, digits, - and _)");
    return 1;
  }
  try {
    if (provider === CLAUDE_CODE_PROVIDER) await claudeLogin(account);
    else await piLogin(provider, account);
  } catch (error) {
    console.error(`login failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  console.log(`signed in — use it with { "model": "${provider}/<model>", "account": "${account}" }`);
  return 0;
}

async function claudeLogin(account: string): Promise<void> {
  const child = spawn("claude", ["auth", "login"], {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeAccountDir(account) },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`could not run \`claude\`: ${error.message}`)));
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(`\`claude auth login\` exited with ${code}`);
}

async function piLogin(providerId: string, account: string): Promise<void> {
  const provider = modelRuntime.getProvider(providerId);
  if (!provider) throw new Error(`unknown provider "${providerId}"`);
  const type = provider.auth.oauth ? "oauth" : "api_key";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runOnAccount(account, () => modelRuntime.login(providerId, type, {
      prompt: (authPrompt) => answer(rl, authPrompt),
      notify: (event) => {
        if (event.type === "auth_url") console.log(`\nOpen this URL in your browser:\n${event.url}${event.instructions ? `\n${event.instructions}` : ""}`);
        else if (event.type === "device_code") console.log(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}`);
        else console.log(event.message);
      },
    }));
  } finally {
    rl.close();
  }
}

async function answer(rl: Interface, prompt: AuthPrompt): Promise<string> {
  const ask = (question: string) => new Promise<string>((resolve) => rl.question(question, resolve));
  if (prompt.type !== "select") return ask(`${prompt.message}${"placeholder" in prompt && prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
  console.log(`\n${prompt.message}`);
  prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
  const chosen = prompt.options[Number.parseInt(await ask(`Enter number (1-${prompt.options.length}): `), 10) - 1];
  if (!chosen) throw new Error("invalid selection");
  return chosen.id;
}

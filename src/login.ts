import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { runOnAccount } from "./accounts.ts";
import { claudeAccountDir, CLAUDE_CODE_PROVIDER } from "./agent/claude-code.ts";
import { modelRuntime } from "./agent/pi.ts";
import { ACCOUNT_NAME, ConfigStore } from "./config.ts";

/** Sign one more login of a provider in, under an account name model entries
 * can point at. Claude Code owns its login, so it runs the CLI's own; every
 * other provider goes through pi's login, stored in the account's auth.json.
 * Whatever the arguments leave out is asked for, providers listed by name. */
export async function login(provider: string | undefined, account: string | undefined): Promise<number> {
  if ((!provider || !account) && !process.stdin.isTTY) {
    console.error("usage: eleven login [provider] [account]  (asks for what is missing in a terminal)");
    return 1;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    provider ??= await pickProvider(rl);
    if (provider !== CLAUDE_CODE_PROVIDER && !modelRuntime.getProvider(provider)) throw new Error(`unknown provider "${provider}"`);
    account ??= await ask(rl, "Account name, to point model entries at (e.g. spare): ");
    if (!ACCOUNT_NAME.test(account)) throw new Error(`invalid account name "${account}" — use letters, digits, - and _`);
    if (provider === CLAUDE_CODE_PROVIDER) {
      // The CLI takes the terminal over from here.
      rl.close();
      await claudeLogin(account);
    } else {
      await piLogin(rl, provider, account);
    }
  } catch (error) {
    console.error(`login failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    rl.close();
  }
  console.log(`signed in — use it with { "model": "${provider}/<model>", "account": "${account}" }`);
  return 0;
}

/** The providers worth a second login: the ones the config runs on, then every
 * subscription — a quota is what runs out. An API-key provider still takes one
 * by name on the command line. */
async function pickProvider(rl: Interface): Promise<string> {
  const used = new Set(new ConfigStore().configuredLogins().map((login) => login.provider));
  const providers = [
    { id: CLAUDE_CODE_PROVIDER, name: "Claude Code" },
    ...modelRuntime.getProviders().filter((p) => p.id !== CLAUDE_CODE_PROVIDER && (p.auth.oauth || (used.has(p.id) && p.auth.apiKey?.login))),
  ].sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)) || a.name.localeCompare(b.name));
  console.log("\nWhich provider?");
  providers.forEach((p, index) => console.log(`  ${String(index + 1).padStart(2)}. ${p.name} (${p.id})${used.has(p.id) ? " — in your models" : ""}`));
  const chosen = providers[Number.parseInt(await ask(rl, `Enter number (1-${providers.length}): `), 10) - 1];
  if (!chosen) throw new Error("invalid selection");
  return chosen.id;
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
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

async function piLogin(rl: Interface, providerId: string, account: string): Promise<void> {
  const type = modelRuntime.getProvider(providerId)!.auth.oauth ? "oauth" : "api_key";
  await runOnAccount(account, () => modelRuntime.login(providerId, type, {
    prompt: (authPrompt) => answer(rl, authPrompt),
    notify: (event) => {
      if (event.type === "auth_url") console.log(`\nOpen this URL in your browser:\n${event.url}${event.instructions ? `\n${event.instructions}` : ""}`);
      else if (event.type === "device_code") console.log(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}`);
      else console.log(event.message);
    },
  }));
}

async function answer(rl: Interface, prompt: AuthPrompt): Promise<string> {
  if (prompt.type !== "select") return ask(rl, `${prompt.message}${"placeholder" in prompt && prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
  console.log(`\n${prompt.message}`);
  prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
  const chosen = prompt.options[Number.parseInt(await ask(rl, `Enter number (1-${prompt.options.length}): `), 10) - 1];
  if (!chosen) throw new Error("invalid selection");
  return chosen.id;
}

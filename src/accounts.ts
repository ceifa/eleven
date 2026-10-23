import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ACCOUNTS_DIR } from "./paths.ts";

/**
 * Named logins, one more per provider than the machine's own. A model entry
 * that names an account runs inside `runOnAccount`, and everything resolving
 * credentials underneath it — pi's request auth, an OAuth refresh, the Claude
 * Code child — picks that account's login instead.
 *
 * Each account is a directory: `auth.json` in pi's format for pi providers,
 * `claude/` as the Claude Code config dir.
 */
const scope = new AsyncLocalStorage<string | undefined>();

export function runOnAccount<T>(account: string | undefined, operation: () => T): T {
  return scope.run(account, operation);
}

/** The account the running operation resolves credentials for; undefined is the machine's own. */
export function currentAccount(): string | undefined {
  return scope.getStore();
}

export function accountDir(account: string, root = ACCOUNTS_DIR): string {
  return join(root, account);
}

// pi keeps its auth.json store out of the package's exports, but it is the
// one that locks the file against pi's own CLI and resolves command-valued
// keys — reused here rather than rewritten.
const { AuthStorage } = await import(new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  AuthStorage: { create(authPath?: string): CredentialStore };
};

/** pi's credential store, routed by account: the machine's auth.json outside
 * any account, the account's own inside one. */
export function accountCredentials(open: (authPath?: string) => CredentialStore = (path) => AuthStorage.create(path)): CredentialStore {
  const machine = open();
  const accounts = new Map<string, CredentialStore>();
  const current = () => {
    const account = currentAccount();
    if (!account) return machine;
    let store = accounts.get(account);
    if (!store) accounts.set(account, store = open(join(accountDir(account), "auth.json")));
    return store;
  };
  return {
    read: (provider, options) => current().read(provider, options),
    list: (options) => current().list(options),
    modify: (provider, fn, options) => current().modify(provider, fn, options),
    delete: (provider, options) => current().delete(provider, options),
  };
}

export interface AccountLogin {
  account: string;
  provider: string;
  /** Who the login is, when the provider says (Claude Code's email). */
  label?: string;
}

/** Every login signed in under an account, read off disk: pi providers from
 * its auth.json, Claude Code from its config dir. */
export function signedInAccounts(root = ACCOUNTS_DIR): AccountLogin[] {
  let accounts: string[];
  try {
    accounts = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  return accounts.flatMap((account) => {
    const logins: AccountLogin[] = Object.keys(readJson(join(root, account, "auth.json")) ?? {}).map((provider) => ({ account, provider }));
    const email = claudeEmail(join(root, account, "claude"));
    if (email) logins.push({ account, provider: "claude-code", label: email });
    return logins;
  });
}

/** The email a Claude Code config dir is signed in as — the machine's own
 * when no dir is given, whose state file sits beside it in $HOME. */
export function claudeEmail(configDir?: string): string | undefined {
  const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const state = readJson(dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json")) as { oauthAccount?: { emailAddress?: unknown } } | undefined;
  const email = state?.oauthAccount?.emailAddress;
  return typeof email === "string" && email ? email : undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

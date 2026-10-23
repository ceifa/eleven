import { AsyncLocalStorage } from "node:async_hooks";
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

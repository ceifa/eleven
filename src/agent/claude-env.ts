import { query as sdkQuery, type SDKControlGetUsageResponse, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { accountDir, currentAccount } from "../accounts.ts";

/* The Claude Code child process as eleven starts it: which login and shell it
   runs with, what of the daemon's environment it may see, and the two probes
   that start one without a prompt (is it signed in, what is left of its quota). */

/** Overrides CLAUDE_CODE_RESUME_PROMPT for sessions eleven resumes (see claudeChildEnv). */
export const RESUME_PROMPT =
  "[This session was resumed after its previous turn was cut off. Your output is delivered as a chat message,"
  + " so ending the turn silently reads to the user as being ignored: if you had already finished a reply that"
  + " never went out, send it again — otherwise carry on and answer. No need to mention the interruption unless"
  + " it changes your answer.]";

const SHELL_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/** The shell Claude Code's Bash tool will run, or undefined if there is none.
 * The CLI only runs zsh or bash: any other $SHELL (fish, nu) makes it fall back
 * to one of those, yet its Environment block still prints $SHELL verbatim, so
 * the model writes syntax for a shell that never sees it. */
export function claudeShell(shell: string | undefined, exists: (path: string) => boolean = existsSync): string | undefined {
  if (shell && /(bash|zsh)$/.test(basename(shell))) return shell;
  return ["zsh", "bash"].flatMap((name) => SHELL_DIRS.map((dir) => `${dir}/${name}`)).find(exists);
}

/** Where Claude Code keeps the machine's own login and every transcript. */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The Claude Code config dir of an account: `CLAUDE_CONFIG_DIR=<it> claude auth
 * login` signs it in. A full login rather than a `setup-token` token, because
 * that one lacks the profile scope the usage windows are read with.
 *
 * Its `projects` links to the machine's own: transcripts live there, and a
 * turn that fails over to another account resumes the hidden Claude session
 * the last one left. A dir of its own would strand them on the old account.
 */
export function claudeAccountDir(account: string, root?: string, home = claudeHome()): string {
  const dir = join(accountDir(account, root), "claude");
  const projects = join(dir, "projects");
  mkdirSync(join(home, "projects"), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = lstatSync(projects, { throwIfNoEntry: false });
  if (!existing) symlinkSync(join(home, "projects"), projects);
  else if (!existing.isSymbolicLink()) {
    throw new Error(`${projects} is a real directory, so account "${account}" cannot resume another account's sessions — remove it`);
  }
  return dir;
}

/** Do not hand Telegram/provider tokens from Eleven's daemon environment to
 * the child. Claude's local login lives under HOME/CLAUDE_CONFIG_DIR, or under
 * the account's own dir when the turn runs on one. */
export function claudeChildEnv(): Record<string, string | undefined> {
  const account = currentAccount();
  const keys = [
    "HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "TZ", "TERM",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS", "CLAUDE_CONFIG_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  // Pin execution to the same shell the prompt announces, so the two cannot drift.
  const shell = claudeShell(process.env.SHELL);
  return {
    ...Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    ...(account && { CLAUDE_CONFIG_DIR: claudeAccountDir(account) }),
    ...(shell && { SHELL: shell, CLAUDE_CODE_SHELL: shell }),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // eleven forces every Bash call into the foreground anyway (see
    // foregroundToolInput): a detached job would be killed the moment Claude
    // returns a result, and there is no next terminal prompt to report it at.
    // Without this the CLI still advertises `run_in_background` — a parameter
    // whose description promises the opposite of what eleven does with it. The
    // flag removes both the parameter and its paragraph from the Bash tool, so
    // the model is not told something untrue and the turn is that much cheaper.
    // The hook stays as the backstop for a runtime that ignores the flag.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "eleven",
    // Pi's bash tool has no default timeout and caps at setTimeout's own ceiling;
    // the Agent SDK caps a requested timeout at 10 minutes, so the same command
    // that runs fine under every other model gets killed under Claude. Match pi's
    // ceiling, for the same reason pi picked it: past 2^31-1 ms a Node timer
    // overflows and fires immediately. This lifts the ceiling only — the default
    // stays short, so a hung command still needs an explicit timeout to hang long.
    BASH_MAX_TIMEOUT_MS: "2147483647",
    // Resuming a session whose turn never finished, Claude Code injects its own
    // "Continue from where you left off." — written for a terminal, where the
    // user is watching the work. Here the turn's output *is* a chat message, so
    // a resumed turn that ends quietly reads as being ignored. Say that, and
    // stop the CLI's default from colliding with eleven's own wake prompt.
    CLAUDE_CODE_RESUME_PROMPT: RESUME_PROMPT,
  };
}

export interface ClaudeAuthProbe {
  ok: boolean;
  detail?: string;
}

/** Per account: each one is a login of its own. */
const authCache = new Map<string | undefined, { value: ClaudeAuthProbe; at: number }>();
const AUTH_CACHE_MS = 60_000;

/** Read the same subscription windows as Claude Code's /usage dialog without
 * issuing a model request. The SDK marks the shape experimental, so the caller
 * intentionally consumes only its small stable-looking rate-limit subset. */
export async function fetchClaudeCodeRateLimits(): Promise<SDKControlGetUsageResponse> {
  const abort = new AbortController();
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> { await parked; }
  const sdk = sdkQuery({
    prompt: noPrompt(),
    options: {
      cwd: process.cwd(), tools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: [], skills: [], plugins: [], persistSession: false,
      abortController: abort,
      env: claudeChildEnv(),
      stderr: () => {},
    },
  });
  const timeout = setTimeout(() => abort.abort(), 15_000);
  timeout.unref();
  const timed = <T>(promise: Promise<T>) => Promise.race([
    promise,
    new Promise<never>((_, reject) => abort.signal.addEventListener(
      "abort", () => reject(new Error("Claude Code usage lookup timed out")), { once: true },
    )),
  ]);
  try {
    await timed(sdk.initializationResult());
    return await timed(sdk.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET());
  } finally {
    clearTimeout(timeout);
    release();
    abort.abort();
    try { sdk.close(); } catch { /* already closed */ }
  }
}

/** Initialize the bundled official runtime without sending a model prompt. */
export async function probeClaudeCodeAuth(queryFn: typeof sdkQuery = sdkQuery): Promise<ClaudeAuthProbe> {
  const cached = authCache.get(currentAccount());
  if (queryFn === sdkQuery && cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.value;
  const abort = new AbortController();
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> { await parked; }
  const sdk = queryFn({
    prompt: noPrompt(),
    options: {
      cwd: process.cwd(),
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: false,
      abortController: abort,
      env: claudeChildEnv(),
      stderr: () => {},
    },
  });
  let value: ClaudeAuthProbe;
  const timeout = setTimeout(() => abort.abort(), 15_000);
  timeout.unref();
  try {
    const init = await Promise.race([
      sdk.initializationResult(),
      new Promise<never>((_, reject) => abort.signal.addEventListener(
        "abort",
        () => reject(new Error("Claude Code initialization timed out")),
        { once: true },
      )),
    ]);
    const account = init.account;
    const ambientProvider = account?.apiProvider && account.apiProvider !== "firstParty";
    const authenticated = !!(ambientProvider || account?.email || account?.subscriptionType || account?.tokenSource || account?.apiKeySource);
    value = { ok: authenticated, detail: account?.subscriptionType || account?.apiProvider };
  } catch (error) {
    value = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    release();
    abort.abort();
    try { sdk.close(); } catch { /* already closed */ }
  }
  if (queryFn === sdkQuery) authCache.set(currentAccount(), { value, at: Date.now() });
  return value;
}

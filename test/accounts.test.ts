import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext, type Model } from "@earendil-works/pi-ai";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Node runs each test file in a process of its own, so pointing these at a
// scratch dir before the modules load keeps every account off the real disk.
const scratch = mkdtempSync(join(tmpdir(), "eleven-accounts-"));
process.env.ELEVEN_STATE_DIR = join(scratch, "state");
process.env.ELEVEN_CONFIG_DIR = join(scratch, "config");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-machine" } }));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const { accountCredentials, accountDir, claudeEmail, runOnAccount, signedInAccounts } = await import("../src/accounts.ts");
const { usageLogins } = await import("../src/provider-usage.ts");
const {
  CLAUDE_CODE_MODELS, claudeAccountDir, createClaudeCodeProvider, registerClaudeSession, unregisterClaudeSession,
} = await import("../src/agent/claude-code.ts");
const { modelRuntime } = await import("../src/agent/pi.ts");
const { ConfigStore, validate, DEFAULT_CONFIG } = await import("../src/config.ts");
const { FailoverOffers } = await import("../src/channels/failover.ts");
const { Runner } = await import("../src/agent/runner.ts");

test("credentials resolve on the account the operation runs on, and on the machine's own outside one", async () => {
  const stores = new Map<string | undefined, InMemoryCredentialStore>();
  const credentials = accountCredentials((path) => {
    const store = new InMemoryCredentialStore();
    stores.set(path, store);
    return store;
  });
  await credentials.modify("openai-codex", async () => ({ type: "api_key", key: "machine" }));
  await runOnAccount("spare", () => credentials.modify("openai-codex", async () => ({ type: "api_key", key: "spare" })));

  assert.deepEqual(await credentials.read("openai-codex"), { type: "api_key", key: "machine" });
  assert.deepEqual(await runOnAccount("spare", () => credentials.read("openai-codex")), { type: "api_key", key: "spare" });
  assert.deepEqual([...stores.keys()], [undefined, join(accountDir("spare"), "auth.json")]);
});

test("a pi request inside an account authenticates with that account's auth.json", async () => {
  mkdirSync(accountDir("spare"), { recursive: true });
  writeFileSync(join(accountDir("spare"), "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-spare" } }));

  const auth = await runOnAccount("spare", () => modelRuntime.getAuth("openai"));

  assert.equal(auth?.auth.apiKey, "sk-spare");
});

test("a catalog refresh fired inside an account keeps reporting the machine's own logins", async () => {
  mkdirSync(accountDir("logged-out"), { recursive: true });
  await modelRuntime.getAvailable();
  assert.equal(modelRuntime.getProviderAuthStatus("openai").configured, true);

  await runOnAccount("logged-out", () => modelRuntime.refresh({ allowNetwork: false }));

  assert.equal(modelRuntime.getProviderAuthStatus("openai").configured, true);
  assert.equal(modelRuntime.hasConfiguredAuth("openai"), true);
});

test("a turn whose account ran dry fails over to the same model on another account", async () => {
  // A provider that answers with the key it was handed, and refuses the drained one.
  const model = {
    id: "m", name: "Fake", api: "fake-accounts", provider: "fake-accounts", baseUrl: "local://fake", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
  } as Model;
  const stream = (_model: unknown, _context: unknown, options?: { apiKey?: string }) => {
    const events = createAssistantMessageEventStream();
    const output = {
      role: "assistant" as const, content: [] as { type: "text"; text: string }[], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as "stop" | "error", errorMessage: undefined as string | undefined, timestamp: Date.now(),
    };
    queueMicrotask(() => {
      events.push({ type: "start", partial: output });
      if (options?.apiKey === "sk-drained") {
        output.stopReason = "error";
        output.errorMessage = "subscription exhausted";
        events.push({ type: "error", reason: "error", error: output });
      } else {
        const text = `answered with ${options?.apiKey}`;
        output.content.push({ type: "text", text });
        events.push({ type: "text_start", contentIndex: 0, partial: output });
        events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        events.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        events.push({ type: "done", reason: "stop", message: output });
      }
      events.end();
    });
    return events;
  };
  modelRuntime.registerNativeProvider({
    id: "fake-accounts", name: "Fake", baseUrl: "local://fake",
    auth: { apiKey: { name: "fake key", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined } },
    getModels: () => [model],
    stream: stream as never,
    streamSimple: stream as never,
  });
  for (const [account, key] of [["drained", "sk-drained"], ["fresh", "sk-fresh"]]) {
    mkdirSync(accountDir(account), { recursive: true });
    writeFileSync(join(accountDir(account), "auth.json"), JSON.stringify({ "fake-accounts": { type: "api_key", key } }));
  }

  const workspace = mkdtempSync(join(scratch, "workspace-"));
  const turn = await new Runner().submit("thread", {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    models: [{ model: "fake-accounts/m", account: "drained" }, { model: "fake-accounts/m", account: "fresh" }],
    sessionDir: join(workspace, "sessions"),
    workspacePath: workspace,
    tools: [],
    text: "hi",
  });

  assert.equal(turn?.text, "answered with sk-fresh");
});

const result = {
  type: "result", subtype: "success", is_error: false, result: "done", session_id: "session",
  duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {}, permission_denials: [], uuid: "result-1",
} as unknown as SDKMessage;

/** Run one Claude Code turn and return the env its child was spawned with. */
async function claudeChildEnv(sessionId: string): Promise<Record<string, string | undefined>> {
  let env: Record<string, string | undefined> = {};
  registerClaudeSession(sessionId, { cwd: scratch, customTools: [] });
  try {
    const provider = createClaudeCodeProvider({
      query: ((input: { options: { env: typeof env } }) => {
        env = input.options.env;
        return Object.assign((async function* () { yield result; })(), { close() {}, interrupt: async () => {} }) as unknown as Query;
      }) as never,
      deleteSession: (async () => {}) as never,
      state: { get: () => undefined, begin: () => {}, markTool: () => {}, commit: () => [], fail: () => ({ removable: [] }), ackDeleted: () => {} } as never,
    });
    const context = normalizeContext({ systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] });
    for await (const _event of provider.streamSimple(CLAUDE_CODE_MODELS[0] as Model, context, { sessionId })) { /* drain */ }
  } finally {
    unregisterClaudeSession(sessionId);
  }
  return env;
}

test("a Claude Code turn inside an account runs out of that account's own login", async () => {
  const env = await runOnAccount("work", () => claudeChildEnv("eeeeeeee-1111-4111-8111-111111111111"));

  assert.equal(env.CLAUDE_CONFIG_DIR, join(accountDir("work"), "claude"));
});

test("a Claude Code turn outside any account keeps the machine's own login", async () => {
  const env = await claudeChildEnv("eeeeeeee-2222-4111-8111-111111111111");

  assert.equal(env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
});

test("every Claude account reads and writes the one transcript store, so a switch can resume", () => {
  const home = join(scratch, "home-a");
  const dir = claudeAccountDir("spare", join(scratch, "accounts-a"), home);

  assert.equal(readlinkSync(join(dir, "projects")), join(home, "projects"));
  // Idempotent: every turn on the account calls it.
  assert.equal(claudeAccountDir("spare", join(scratch, "accounts-a"), home), dir);
});

test("a Claude account dir with transcripts of its own is refused, not silently split off", () => {
  const root = join(scratch, "accounts-b");
  mkdirSync(join(root, "spare", "claude", "projects"), { recursive: true });

  assert.throws(() => claudeAccountDir("spare", root, join(scratch, "home-b")), /real directory/);
  assert.ok(existsSync(join(root, "spare", "claude", "projects")));
});

test("the same model on two accounts stays two candidates in the plan", () => {
  const store = Object.assign(Object.create(ConfigStore.prototype), {
    resolved: {
      ...DEFAULT_CONFIG,
      models: [
        { model: "openai-codex/gpt-6" },
        { model: "openai-codex/gpt-6", account: "spare" },
        { model: "openai-codex/gpt-6" },
        { model: "claude-code/opus", account: "spare" },
      ],
    },
  }) as InstanceType<typeof ConfigStore>;

  assert.deepEqual(store.turnModels(), [
    { model: "openai-codex/gpt-6" },
    { model: "openai-codex/gpt-6", account: "spare" },
    { model: "claude-code/opus", account: "spare" },
  ]);
  assert.deepEqual(store.configuredLogins(), [
    { provider: "openai-codex" },
    { provider: "openai-codex", account: "spare" },
    { provider: "claude-code", account: "spare" },
  ]);
});

test("an account must be a name that can be a directory", () => {
  const config = (models: object[]) => ({ ...DEFAULT_CONFIG, models } as never);

  assert.doesNotThrow(() => validate(config([{ model: "kiro/claude-opus-5-5", account: "spare-2" }])));
  assert.throws(() => validate(config([{ model: "openai-codex/gpt-6", account: "../escape" }])), /invalid account name/);
});

test("a failover onto another account says which one", () => {
  const buttons = new FailoverOffers<string>().offer("telegram:main:7", "replay", {
    remaining: [{ model: "openai-codex/gpt-6", account: "spare" }],
    hiddenToolCalls: [],
  });
  const labels = buttons?.[0]?.map((button) => button.label);

  assert.deepEqual(labels, ["▶ Continue on gpt-6 (spare)", "↻ Restart on gpt-6 (spare)"]);
});

test("the accounts on disk list every login signed in under them, Claude Code by its email", () => {
  const root = join(scratch, "accounts-listed");
  mkdirSync(join(root, "wiv", "claude"), { recursive: true });
  writeFileSync(join(root, "wiv", "claude", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@wiv.dev" } }));
  mkdirSync(join(root, "spare"), { recursive: true });
  writeFileSync(join(root, "spare", "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }));
  // Logged out: the dir is there, the login is not.
  mkdirSync(join(root, "gone", "claude"), { recursive: true });
  writeFileSync(join(root, "gone", "claude", ".claude.json"), JSON.stringify({}));

  assert.deepEqual(signedInAccounts(root), [
    { account: "spare", provider: "openai-codex" },
    { account: "wiv", provider: "claude-code", label: "me@wiv.dev" },
  ]);
  assert.equal(claudeEmail(join(root, "wiv", "claude")), "me@wiv.dev");
});

test("usage covers every signed-in account of a provider in use, not only the ones an entry names", () => {
  mkdirSync(join(accountDir("usage-a"), "claude"), { recursive: true });
  writeFileSync(join(accountDir("usage-a"), "claude", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@x.dev" } }));

  const logins = usageLogins([{ provider: "claude-code" }, { provider: "kiro" }]);

  assert.deepEqual(logins.filter((login) => login.provider === "claude-code"), [
    { provider: "claude-code" },
    { provider: "claude-code", account: "usage-a" },
  ]);
  // A provider nobody runs stays out, signed in or not.
  assert.ok(!logins.some((login) => login.provider === "fake-accounts"));
});

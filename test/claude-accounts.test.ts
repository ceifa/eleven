import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Node runs each test file in a process of its own, so pointing these at a
// scratch dir before the modules load keeps every account off the real disk.
const scratch = mkdtempSync(join(tmpdir(), "eleven-claude-accounts-"));
process.env.ELEVEN_STATE_DIR = join(scratch, "state");
process.env.ELEVEN_CONFIG_DIR = join(scratch, "config");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const {
  CLAUDE_CODE_MODELS, claudeAccountDir, createClaudeCodeProvider, registerClaudeSession,
  setClaudeAccount, unregisterClaudeSession,
} = await import("../src/agent/claude-code.ts");
const { ConfigStore, validate, DEFAULT_CONFIG } = await import("../src/config.ts");
const { FailoverOffers } = await import("../src/channels/telegram/failover.ts");

const result = {
  type: "result", subtype: "success", is_error: false, result: "done", session_id: "session",
  duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {}, permission_denials: [], uuid: "result-1",
} as unknown as SDKMessage;

/** Run one turn and return the env the child was spawned with. */
async function childEnv(sessionId: string, account?: string): Promise<Record<string, string | undefined>> {
  let env: Record<string, string | undefined> = {};
  registerClaudeSession(sessionId, { cwd: scratch, customTools: [] });
  setClaudeAccount(sessionId, account);
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

test("a turn on a named account runs Claude out of that account's own login", async () => {
  const env = await childEnv("eeeeeeee-1111-4111-8111-111111111111", "work");

  assert.equal(env.CLAUDE_CONFIG_DIR, join(process.env.ELEVEN_STATE_DIR!, "claude-accounts", "work"));
});

test("a turn without an account keeps the machine's own login", async () => {
  const env = await childEnv("eeeeeeee-2222-4111-8111-111111111111");

  assert.equal(env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
});

test("every account reads and writes the one transcript store, so a switch can resume", () => {
  const home = join(scratch, "home-a");
  const dir = claudeAccountDir("spare", join(scratch, "accounts-a"), home);

  assert.equal(readlinkSync(join(dir, "projects")), join(home, "projects"));
  // Idempotent: every turn on the account calls it.
  assert.equal(claudeAccountDir("spare", join(scratch, "accounts-a"), home), dir);
});

test("an account dir with transcripts of its own is refused, not silently split off", () => {
  const root = join(scratch, "accounts-b");
  mkdirSync(join(root, "spare", "projects"), { recursive: true });

  assert.throws(() => claudeAccountDir("spare", root, join(scratch, "home-b")), /real directory/);
  assert.ok(existsSync(join(root, "spare", "projects")));
});

test("the same model on two accounts stays two candidates in the plan", () => {
  const store = Object.assign(Object.create(ConfigStore.prototype), {
    resolved: {
      ...DEFAULT_CONFIG,
      models: [
        { model: "claude-code/opus" },
        { model: "claude-code/opus", account: "spare" },
        { model: "claude-code/opus" },
      ],
    },
  }) as InstanceType<typeof ConfigStore>;

  assert.deepEqual(store.turnModels(), [{ model: "claude-code/opus" }, { model: "claude-code/opus", account: "spare" }]);
  assert.deepEqual(store.configuredClaudeAccounts(), [undefined, "spare"]);
});

test("an account is only accepted on a Claude Code model, under a name that can be a directory", () => {
  const config = (models: object[]) => ({ ...DEFAULT_CONFIG, models } as never);

  assert.doesNotThrow(() => validate(config([{ model: "claude-code/opus", account: "spare-2" }])));
  assert.throws(() => validate(config([{ model: "kiro/claude-opus-5-5", account: "spare" }])), /only applies to claude-code/);
  assert.throws(() => validate(config([{ model: "claude-code/opus", account: "../escape" }])), /invalid account name/);
});

test("a failover onto another account says which one", () => {
  const keyboard = new FailoverOffers<string>().offer("telegram:main:7", "replay", {
    remaining: [{ model: "claude-code/opus", account: "spare" }],
    hiddenToolCalls: [],
  });
  const labels = keyboard?.inline_keyboard[0]?.map((button) => button.text);

  assert.deepEqual(labels, ["▶ Continue on opus (spare)", "↻ Restart on opus (spare)"]);
});

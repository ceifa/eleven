import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const USAGE_MODULE = new URL("../src/provider-usage.ts", import.meta.url).href;

/** Registers "kiro" the way pi-provider-kiro does: the quota reader rides on the OAuth config. */
const KIRO_EXTENSION = `export default function (pi) {
  pi.registerProvider("kiro", {
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    oauth: {
      name: "Kiro",
      login: async () => { throw new Error("no login in tests"); },
      refreshToken: async (credential) => credential,
      getApiKey: (credential) => credential.access,
      fetchUsage: async (credential) => {
        if (credential.access !== "kiro-token") throw new Error("wrong credential");
        return {
          subscriptionTitle: "KIRO POWER",
          usageBuckets: [{ id: "CREDIT", label: "Credit", resourceType: "CREDIT", used: 7500, limit: 10000, resetAt: "2026-11-01T00:00:00.000Z" }],
        };
      },
    },
  });
}
`;

test("Kiro usage is read through the quota reader its extension registers", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-kiro-usage-"));
  try {
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeFileSync(join(dir, "extensions", "kiro.ts"), KIRO_EXTENSION);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      kiro: { type: "oauth", access: "kiro-token", refresh: "r", expires: Date.now() + 3_600_000 },
    }));
    const script = `const { fetchUsageForProvider } = await import(${JSON.stringify(USAGE_MODULE)});
console.log(JSON.stringify(await fetchUsageForProvider("kiro")));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1)!), {
      provider: "Kiro",
      plan: "Kiro Power",
      windows: [{ label: "Credit", usedPercent: 75, resetAt: Date.parse("2026-11-01T00:00:00.000Z") }],
      credits: 2500,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

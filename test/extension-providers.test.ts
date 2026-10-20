import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PI_MODULE = new URL("../src/agent/pi.ts", import.meta.url).href;

/** An extension that brings one provider with one model, the way pi-provider-kiro does. */
function providerExtension(provider: string) {
  return `export default function (pi) {
  pi.registerProvider(${JSON.stringify(provider)}, {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "unused",
    api: "openai-completions",
    models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });
}
`;
}

/** Imports pi.ts in a fresh process pointed at `agentDir`, from `cwd`, and asks it for each model ref. */
function lookup(agentDir: string, cwd: string, refs: string[]): Record<string, boolean> {
  const script = `const { findModel } = await import(${JSON.stringify(PI_MODULE)});
console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(refs)}.map((ref) => [ref, Boolean(findModel(ref))]))));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

test("a provider a global extension registers is in the catalog before any session runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-ext-providers-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "global.ts"), providerExtension("global-ext"));

    // A workspace's own extension stays in its sessions: the catalog is shared.
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "extensions", "local.ts"), providerExtension("local-ext"));

    assert.deepEqual(lookup(agentDir, workspace, ["global-ext/m1", "local-ext/m1"]), {
      "global-ext/m1": true,
      "local-ext/m1": false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

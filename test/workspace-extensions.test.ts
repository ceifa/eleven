import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

const scratch = mkdtempSync(join(tmpdir(), "eleven-workspace-extensions-"));
process.env.ELEVEN_STATE_DIR = join(scratch, "state");
process.env.ELEVEN_CONFIG_DIR = join(scratch, "config");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const { modelRuntime } = await import("../src/agent/pi.ts");
const { Runner } = await import("../src/agent/runner.ts");

const model = {
  id: "quiet", name: "quiet", api: "ext-quiet", provider: "ext", baseUrl: "local://ext",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
} as Model;
const stream = () => {
  const out = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  queueMicrotask(() => {
    out.push({ type: "done", reason: "stop", message });
    out.end();
  });
  return out;
};
modelRuntime.registerNativeProvider({
  id: "ext", name: "Ext", baseUrl: "local://ext",
  auth: { apiKey: { name: "unused", resolve: async () => ({ auth: { apiKey: "unused" }, source: "stored" }) } },
  getModels: () => [model], stream, streamSimple: stream,
});

test("a workspace extension that fails to load is logged, not dropped silently", async (t) => {
  const workspace = join(scratch, "workspace");
  mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "extensions", "broken.ts"),
    'import { nothing } from "@eleven-test/missing-module";\nexport default function () { void nothing; }\n');
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => { warnings.push(String(line)); });

  await new Runner().submit("thread", {
    runtime: { channel: "test", workspace: "test", workspacePath: workspace },
    sessionDir: join(scratch, "sessions"), workspacePath: workspace, tools: ["read" as const], models: [{ model: "ext/quiet" }],
    text: "hi",
  });

  const line = warnings.find((warning) => warning.includes("broken.ts"));
  assert.ok(line, `no warning names the broken extension; got:\n${warnings.join("\n")}`);
  assert.match(line, /failed to load/);
  assert.match(line, /@eleven-test\/missing-module/);
});

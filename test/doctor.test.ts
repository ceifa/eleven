import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

test("doctor checks a Google Chat channel's service account, not a Telegram bot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-doctor-"));
  const key = join(dir, "not-a-key.json");
  writeFileSync(key, JSON.stringify({ type: "authorized_user" }));
  writeFileSync(join(dir, "eleven.json"), JSON.stringify({
    models: [],
    workspaces: {
      w: {
        path: dir,
        channels: [{ type: "googlechat", name: "chat", token: key, googlechat: { port: 8790, audience: "123" } }],
      },
    },
  }));
  const result = await run(process.execPath, ["src/cli.ts", "doctor"], {
    env: { ...process.env, ELEVEN_CONFIG_DIR: dir, ELEVEN_STATE_DIR: join(dir, "state") },
  }).catch((error: { stdout: string }) => error);
  const line = result.stdout.split("\n").find((l: string) => l.includes("channel chat"));
  assert.ok(line, result.stdout);
  assert.doesNotMatch(line, /getMe/);
  assert.match(line, /service account check failed: .*not a service account key/);
});

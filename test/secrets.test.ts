import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import test from "node:test";
import { ComponentType, InteractionResponseType, type APIModalSubmission } from "discord-api-types/v10";
import { parseSecretId, secretButton, secretModal, submittedValue } from "../src/channels/discord/secret.ts";
import { discordTool } from "../src/channels/discord/tool.ts";
import type { DiscordRest } from "../src/channels/discord/rest.ts";
import { EphemeralSecrets, SecretMask, secretsRequest, serveSecrets } from "../src/secrets.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

test("a secret lives in memory for its minutes and then is gone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new EphemeralSecrets();
  const { expiresAt } = store.put("DB_PASSWORD", "hunter2", 5, 1_000);
  assert.equal(expiresAt, 1_000 + 5 * 60_000);
  assert.deepEqual(store.list(), [{ name: "DB_PASSWORD", expiresAt }]);
  t.mock.timers.tick(5 * 60_000 - 1);
  assert.equal(store.get("DB_PASSWORD"), "hunter2");
  t.mock.timers.tick(1);
  assert.equal(store.get("DB_PASSWORD"), undefined);
  assert.deepEqual(store.list(), []);
});

test("sending a secret again replaces it and restarts its clock; a bad name is refused", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new EphemeralSecrets();
  store.put("TOKEN", "old", 1);
  t.mock.timers.tick(30_000);
  store.put("TOKEN", "new", 1);
  t.mock.timers.tick(45_000);
  assert.equal(store.get("TOKEN"), "new");
  assert.throws(() => store.put("lower", "x", 1), /invalid secret name/);
  assert.throws(() => store.put("A/../B", "x", 1), /invalid secret name/);
});

test("the mask hides a value even when it is split across chunks or next to multibyte text", async () => {
  const value = "s3cr3t-válue";
  const bytes = Buffer.from(`before ${value} middle ${value}ção after`);
  // One byte at a time: every possible split point, including inside "á" and "ç".
  const chunks = [...bytes].map((byte) => Buffer.from([byte]));
  const out = await text(Readable.from(chunks).pipe(new SecretMask([{ name: "TOKEN", value }])));
  assert.equal(out, "before [TOKEN] middle [TOKEN]ção after");
});

test("the socket lists names, hands out a value, forgets on request, and is owner-only", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, "secrets.sock");
  const store = new EphemeralSecrets();
  store.put("API_KEY", "abc123", 10);
  const server = serveSecrets(store, socket);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const list = await secretsRequest<{ name: string }[]>("GET", "/secrets", socket);
  assert.deepEqual(list.map((entry) => entry.name), ["API_KEY"]);
  assert.ok(!JSON.stringify(list).includes("abc123"), "listing never carries values");
  assert.deepEqual(await secretsRequest("GET", "/secrets/API_KEY", socket), { name: "API_KEY", value: "abc123" });
  assert.deepEqual(await secretsRequest("DELETE", "/secrets/API_KEY", socket), { deleted: true });
  await assert.rejects(secretsRequest("GET", "/secrets/API_KEY", socket), /expired or never sent/);
});

test("`eleven secrets run` hands the value to the command and masks it in what the command prints", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EphemeralSecrets();
  store.put("API_KEY", "abc123", 10);
  const server = serveSecrets(store, join(dir, "secrets.sock"));
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const env = { ...process.env, ELEVEN_STATE_DIR: dir, ELEVEN_CONFIG_DIR: dir };
  const script = 'test "$API_KEY" = abc123 && echo "ok $API_KEY" && echo "err $API_KEY" >&2 && exit 3';
  // spawnSync would block the server answering in this same process.
  const child = spawn(process.execPath, [CLI, "secrets", "run", "API_KEY", "--", "sh", "-c", script], { env });
  const [stdout, stderr, code] = await Promise.all([
    text(child.stdout), text(child.stderr), new Promise((resolve) => child.on("exit", resolve)),
  ]);
  assert.equal(stdout, "ok [API_KEY]\n");
  assert.equal(stderr, "err [API_KEY]\n");
  assert.equal(code, 3);
});

test("`eleven secrets run` for a secret that is not there fails before running anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-secrets-"));
  try {
    const env = { ...process.env, ELEVEN_STATE_DIR: dir, ELEVEN_CONFIG_DIR: dir };
    const run = spawnSync(process.execPath, [CLI, "secrets", "run", "MISSING", "--", "echo", "ran"], { env, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /secret socket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the secret button opens a form whose answer is read back from either Discord layout", () => {
  const button = secretButton({ name: "DB_PASSWORD", minutes: 9999 });
  assert.equal(button.data, "eleven-secret:DB_PASSWORD:1440");
  assert.deepEqual(parseSecretId(button.data!), { name: "DB_PASSWORD", minutes: 1440 });
  assert.equal(parseSecretId("eleven-secret:bad name:5"), undefined);
  assert.equal(parseSecretId("something-else"), undefined);

  const modal = secretModal(button.data!, { name: "DB_PASSWORD", minutes: 30 });
  assert.equal(modal.type, InteractionResponseType.Modal);

  const labelled = { custom_id: button.data, components: [
    { type: ComponentType.Label, id: 1, component: { type: ComponentType.TextInput, id: 2, custom_id: "value", value: " pa ss\n" } },
  ] } as unknown as APIModalSubmission;
  const rowed = { custom_id: button.data, components: [
    { type: ComponentType.ActionRow, components: [{ type: ComponentType.TextInput, custom_id: "value", value: "pass" }] },
  ] } as unknown as APIModalSubmission;
  assert.equal(submittedValue(labelled), "pa ss");
  assert.equal(submittedValue(rowed), "pass");
});

test("the discord tool asks for a secret with the button, never with the value", async () => {
  const sent: unknown[] = [];
  const rest = { request: async (_method: string, _path: string, options: { body: unknown }) => {
    sent.push(options.body);
    return { id: "42" };
  } } as unknown as DiscordRest;
  const tool = discordTool(rest, "channel");
  const run = (params: unknown) => tool.execute("call", params as never, undefined, undefined, undefined as never);
  const answer = await run({ action: "secret", secret: { name: "STAGING_DB", minutes: 15 }, text: "For the migration" });
  assert.match((answer.content[0] as { text: string }).text, /asked for STAGING_DB/);
  const body = sent[0] as { content: string; components: { components: { custom_id: string }[] }[] };
  assert.equal(body.content, "For the migration");
  assert.equal(body.components[0].components[0].custom_id, "eleven-secret:STAGING_DB:15");
  const refused = await run({ action: "secret", secret: { name: "staging db" } });
  assert.match((refused.content[0] as { text: string }).text, /needs a name/);
  assert.equal(sent.length, 1);
});

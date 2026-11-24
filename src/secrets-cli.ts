import { spawn } from "node:child_process";
import { constants } from "node:os";
import { SECRET_NAME, SecretMask, secretsRequest, type SecretInfo } from "./secrets.ts";

/** `eleven secrets …`: the agent's side of an ephemeral secret. Returns the exit code. */
export async function runSecrets(args: string[], socketPath?: string): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    const list = await secretsRequest<SecretInfo[]>("GET", "/secrets", socketPath);
    if (!list.length) console.log("no secrets");
    for (const { name, expiresAt } of list) console.log(`${name}  expires ${new Date(expiresAt).toLocaleTimeString()}`);
    return 0;
  }
  if (sub === "drop" && rest.length === 1) {
    const { deleted } = await secretsRequest<{ deleted: boolean }>("DELETE", `/secrets/${encodeURIComponent(rest[0])}`, socketPath);
    console.log(deleted ? `${rest[0]} dropped` : `no secret named ${rest[0]}`);
    return 0;
  }
  if (sub === "run") {
    const split = rest.indexOf("--");
    const names = split === -1 ? [] : rest.slice(0, split);
    const command = split === -1 ? [] : rest.slice(split + 1);
    if (!names.length || !command.length) throw new Error("usage: eleven secrets run <NAME>... -- <command> [args]");
    const invalid = names.find((name) => !SECRET_NAME.test(name));
    if (invalid) throw new Error(`invalid secret name: ${invalid}`);
    const values = await Promise.all(names.map((name) =>
      secretsRequest<{ name: string; value: string }>("GET", `/secrets/${encodeURIComponent(name)}`, socketPath)));
    return run(command, values);
  }
  throw new Error("unknown secrets command; see eleven --help");
}

async function run([file, ...argv]: string[], values: { name: string; value: string }[]): Promise<number> {
  const env = { ...process.env, ...Object.fromEntries(values.map(({ name, value }) => [name, value])) };
  const child = spawn(file, argv, { env, stdio: ["inherit", "pipe", "pipe"] });
  const drained = [[child.stdout, process.stdout], [child.stderr, process.stderr]].map(([from, to]) => {
    const mask = new SecretMask(values);
    from.pipe(mask).pipe(to as NodeJS.WritableStream, { end: false });
    return new Promise((resolve) => mask.on("end", resolve));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  const [code] = await Promise.all([exit, ...drained]);
  return code;
}

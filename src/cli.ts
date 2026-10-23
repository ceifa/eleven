#!/usr/bin/env node
import { controlService, installService, serviceInstalled } from "./service.ts";
import { runClientCommand } from "./cli-client.ts";

const [, , command, ...args] = process.argv;

// Set when this process was spawned by the service itself (ELEVEN_SUPERVISED
// comes from the unit/plist; INVOCATION_ID covers systemd units written before
// it existed). Delegating to the supervisor from inside the service's own
// exec would deadlock.
const supervised = Boolean(process.env.ELEVEN_SUPERVISED || process.env.INVOCATION_ID);

let clientHandled = false;
try {
  clientHandled = await runClientCommand(command, args);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
  clientHandled = true;
}

if (!clientHandled) switch (command) {
  case "start":
  case "restart":
    if (!supervised && !args.includes("--foreground") && serviceInstalled()) {
      controlService(command);
      break;
    }
    // Imported on demand: loading the model catalog runs every global pi
    // extension, which the client commands above never need.
    await (await import("./daemon.ts")).startDaemon();
    break;
  case "init":
    process.exitCode = installService() ? 0 : 1;
    break;
  case "doctor":
    process.exitCode = (await (await import("./doctor.ts")).runDoctor()) ? 0 : 1;
    break;
  case "claude-login":
    process.exitCode = await (await import("./claude-login.ts")).claudeLogin(args[0]);
    break;
  default:
    console.log(`eleven — a featherweight personal AI gateway

usage:
  eleven start                         start the daemon (service or foreground)
  eleven restart                       restart the daemon
  eleven init                          install and start the background service
  eleven doctor                        check config, providers, channels and workspaces
  eleven claude-login <account>        sign a Claude account in for models that name it

  eleven status [--json]               show live gateway health
  eleven workspaces [name] [--json]    list workspaces or show resolved detail
  eleven threads [filters]             list current threads
  eleven threads <id> [--json]         show thread detail (unique prefix accepted)
  eleven threads invoke --workspace <name> [--timeout <seconds>] [--detach] [--json] <message>
  eleven threads send <id> [--json] <message>

thread filters:
  --workspace <name>  --running  --channel <type>  --since <24h|7d|ISO>
  --limit <n>         --all

flags:
  --foreground             with start/restart: run in this terminal even if the
                           background service is installed
  --json                   machine-readable output on inspection/client commands
  --timeout <seconds>      with threads invoke: wait up to this many seconds
                           (positive integer, default 1800); does not cancel the turn`);
    if (command) process.exitCode = 1;
}

#!/usr/bin/env node
import { startDaemon } from "./daemon.ts";
import { runDoctor } from "./doctor.ts";
import { controlService, installService, serviceInstalled } from "./service.ts";
import { importOpenclaw } from "./import-openclaw.ts";
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
    await startDaemon();
    break;
  case "init":
    process.exitCode = installService() ? 0 : 1;
    break;
  case "doctor":
    process.exitCode = (await runDoctor()) ? 0 : 1;
    break;
  case "import":
    if (args[0] === "openclaw") {
      await importOpenclaw();
      break;
    }
    console.error(`unknown import source: ${args[0] ?? "(none)"} — supported: openclaw`);
    process.exitCode = 1;
    break;
  default:
    console.log(`eleven — a featherweight personal AI gateway

usage:
  eleven start                         start the daemon (service or foreground)
  eleven restart                       restart the daemon
  eleven init                          install and start the background service
  eleven doctor                        check config, providers, channels and workspaces
  eleven import openclaw               import an OpenClaw install

  eleven status [--json]               show live gateway health
  eleven workspaces [name] [--json]    list workspaces or show resolved detail
  eleven threads [filters]             list current threads
  eleven threads <id> [--json]         show thread detail (unique prefix accepted)
  eleven threads invoke --workspace <name> [--detach] [--json] <message>
  eleven threads send <id> [--json] <message>

thread filters:
  --workspace <name>  --running  --channel <type>  --since <24h|7d|ISO>
  --limit <n>         --all

flags:
  --foreground             with start/restart: run in this terminal even if the
                           background service is installed
  --json                   machine-readable output on inspection/client commands`);
    if (command) process.exitCode = 1;
}

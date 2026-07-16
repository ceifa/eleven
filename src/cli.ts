#!/usr/bin/env node
import { startDaemon } from "./daemon.ts";
import { runDoctor } from "./doctor.ts";
import { controlService, installService, serviceInstalled } from "./service.ts";
import { importOpenclaw } from "./import-openclaw.ts";

const [, , command, ...args] = process.argv;

// Set when this process was spawned by the service itself (ELEVEN_SUPERVISED
// comes from the unit/plist; INVOCATION_ID covers systemd units written before
// it existed). Delegating to the supervisor from inside the service's own
// exec would deadlock.
const supervised = Boolean(process.env.ELEVEN_SUPERVISED || process.env.INVOCATION_ID);

switch (command) {
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
  eleven start             start the daemon (via the service when installed, else foreground)
  eleven restart           restart the daemon
  eleven init              install, enable and start the background service
                           (systemd on Linux, launchd on macOS)
  eleven doctor            check config, providers, telegram and workspaces
  eleven import openclaw   bring config over from an OpenClaw install

flags:
  --foreground             with start/restart: run in this terminal even if the
                           background service is installed`);
    if (command) process.exitCode = 1;
}

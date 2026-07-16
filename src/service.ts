import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { IS_MAC, SERVICE_FILE, SERVICE_LABEL } from "./paths.ts";

/** True when the background service has been installed via `eleven init`. */
export function serviceInstalled(): boolean {
  return existsSync(SERVICE_FILE);
}

/** Start or restart the installed service through its supervisor. */
export function controlService(action: "start" | "restart") {
  if (IS_MAC) {
    // kickstart starts a stopped agent; -k additionally kills a running one.
    const target = `${launchdDomain()}/${SERVICE_LABEL}`;
    execFileSync("launchctl", action === "restart" ? ["kickstart", "-k", target] : ["kickstart", target], { stdio: "inherit" });
  } else {
    execFileSync("systemctl", ["--user", action, "eleven.service"], { stdio: "inherit" });
  }
}

/**
 * Writes a systemd user unit (Linux) or a launchd agent (macOS) and starts it.
 * Paths are absolute on purpose: version-manager shims (fnm/nvm) break inside
 * a supervisor when the node they resolve to is garbage-collected by a later
 * install. Returns false on platforms without a supported supervisor.
 */
export function installService(): boolean {
  if (!IS_MAC && process.platform !== "linux") {
    console.error(`eleven init is not supported on ${process.platform}; run "eleven start --foreground" instead`);
    return false;
  }

  const cliPath = join(import.meta.dirname, "cli.ts");

  mkdirSync(dirname(SERVICE_FILE), { recursive: true });
  writeFileSync(SERVICE_FILE, IS_MAC ? launchdAgent(cliPath) : systemdUnit(cliPath));
  console.log(`wrote ${SERVICE_FILE}`);
  console.log(`  node: ${process.execPath}`);
  console.log(`  cli:  ${cliPath}`);

  if (IS_MAC) {
    // Re-running init must survive an already-bootstrapped agent.
    try {
      execFileSync("launchctl", ["bootout", `${launchdDomain()}/${SERVICE_LABEL}`], { stdio: "ignore" });
    } catch {}
    execFileSync("launchctl", ["bootstrap", launchdDomain(), SERVICE_FILE], { stdio: "inherit" });
  } else {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "eleven.service"], { stdio: "inherit" });
  }
  console.log("service enabled and started");
  return true;
}

function launchdDomain(): string {
  return `gui/${process.getuid!()}`;
}

function systemdUnit(cliPath: string): string {
  return `[Unit]
Description=eleven — personal AI gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${unitQuote(process.execPath)} ${unitQuote(cliPath)} start
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=ELEVEN_SUPERVISED=1

[Install]
WantedBy=default.target
`;
}

function launchdAgent(cliPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>ELEVEN_SUPERVISED</key><string>1</string>
  </dict>
</dict>
</plist>
`;
}

/** Quote a path for a systemd exec line; % is the unit-specifier escape. */
function unitQuote(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

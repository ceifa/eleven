import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigStore } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { TelegramChannel } from "./channels/telegram/index.ts";
import { startDashboard } from "./dashboard/server.ts";
import { refreshModelCatalogs, trustWorkspaces } from "./agent/pi.ts";
import { PID_FILE } from "./paths.ts";
import { readJsonFile, writeJsonFile } from "./util.ts";
import { logger } from "./log.ts";

const log = logger("daemon");

const workspacePaths = (config: ConfigStore) => Object.values(config.resolved.workspaces).map((w) => w.path);

/** Kernel start time of a process (field 22 of /proc/<pid>/stat), or undefined off-linux. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) can contain spaces and parens; fields 3+ start after the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Pid from the pidfile if that process is still alive and really is the one we recorded. */
function runningPid(): number | undefined {
  const { pid, starttime } = readJsonFile<{ pid?: number; starttime?: string }>(PID_FILE, {});
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
  } catch {
    return undefined;
  }
  // On linux, make sure the pid wasn't recycled by an unrelated process.
  const current = processStartTime(pid);
  if (starttime && current && current !== starttime) return undefined;
  return pid;
}

/** Stops a previous instance (SIGTERM, then SIGKILL after 5s) so this one can take over. */
async function stopExisting() {
  const pid = runningPid();
  if (!pid) return;
  log.info(`eleven already running (pid ${pid}), restarting`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
  log.warn(`pid ${pid} did not exit after SIGTERM, sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  // Wait for the kernel to actually reap it before we start polling the same bot
  // token — otherwise both processes hit getUpdates and Telegram returns 409s.
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
  log.warn(`pid ${pid} still present after SIGKILL`);
}

export async function startDaemon() {
  await stopExisting();
  writeJsonFile(PID_FILE, { pid: process.pid, starttime: processStartTime(process.pid) });

  const config = new ConfigStore();
  trustWorkspaces(workspacePaths(config));
  config.on("change", () => trustWorkspaces(workspacePaths(config)));

  const gateway = new Gateway(config);
  const telegram = new TelegramChannel(config, gateway);
  const dashboard = startDashboard(config, gateway, telegram);
  // Off the startup path on purpose: pi resolves models from the bundled
  // catalog immediately, and this only widens it to what the providers list now.
  const stopCatalogRefresh = refreshModelCatalogs();

  log.info("eleven is up");

  // If a turn was cut off by the last stop (e.g. the agent restarted eleven
  // from inside its own turn), nudge those conversations so the agent finishes
  // the reply it never got to send.
  const interrupted = gateway.interruptedTurns();
  if (interrupted.length) {
    log.info(`waking ${interrupted.length} interrupted conversation(s)`);
    telegram.wakeInterrupted(interrupted);
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    stopCatalogRefresh();
    await Promise.allSettled([telegram.stop(), dashboard.close()]);
    rmSync(PID_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

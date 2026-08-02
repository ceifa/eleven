import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const CONFIG_DIR = process.env.ELEVEN_CONFIG_DIR ?? join(home, ".config", "eleven");
export const CONFIG_FILE = join(CONFIG_DIR, "eleven.json");

export const STATE_DIR = process.env.ELEVEN_STATE_DIR ?? join(home, ".local", "share", "eleven");
export const THREADS_DIR = join(STATE_DIR, "threads");
export const MEDIA_DIR = join(STATE_DIR, "media");
export const REQUESTS_DIR = join(STATE_DIR, "requests");
export const THREAD_STORE_FILE = join(STATE_DIR, "threads.json");
export const PENDING_TURNS_FILE = join(STATE_DIR, "pending-turns.json");
export const CLAUDE_SESSIONS_FILE = join(STATE_DIR, "claude-sessions.json");
export const PAIRING_FILE = join(STATE_DIR, "pairing.json");
export const PID_FILE = join(STATE_DIR, "eleven.pid");

export const IS_MAC = process.platform === "darwin";

export const SERVICE_LABEL = "com.ceifa.eleven";
export const SERVICE_FILE = IS_MAC
  ? join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
  : join(home, ".config", "systemd", "user", "eleven.service");

export function expandHome(path: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

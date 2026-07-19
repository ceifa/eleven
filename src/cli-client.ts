import { text as readStream } from "node:stream/consumers";
import { homedir } from "node:os";
import { ConfigStore } from "./config.ts";

type Json = Record<string, unknown>;

type ThreadView = {
  id: string;
  sessionKey: string;
  workspace: string;
  sessionFile?: string;
  model?: string;
  title?: string;
  createdAt: number;
  lastActivityAt: number;
  current: boolean;
  running: boolean;
  state: "running" | "current" | "old";
  source: string;
  conversation: string;
  effectiveModel?: string;
  lastModel?: string;
  messages?: number;
  turns?: number;
};

type CliRun = {
  status: "running" | "done" | "error";
  result?: { text?: string; model?: string };
  error?: string;
};

type WorkspaceView = {
  name: string;
  path: string;
  pathExists: boolean;
  model: string;
  modelSource: string;
  fallbacks: string[];
  thinking: string;
  tools: string[];
  customPrompt: boolean;
  channels: { type: string; name: string; username?: string; connected: boolean; users: number; groups: number }[];
  threads: { total: number; current: number; running: number };
  session: { idleDays: number; retentionDays: number };
  skills?: { name: string; description: string }[];
};

/** Handle CLI commands backed by the running daemon's local control API. */
export async function runClientCommand(command: string | undefined, inputArgs: string[]): Promise<boolean> {
  if (command === "status") {
    const args = [...inputArgs];
    const json = takeFlag(args, "--json");
    rejectArgs(args);
    const status = await api<Json>("/status");
    if (json) return printJson(status);
    const channels = status.channels as { total: number; healthy: number };
    const threads = status.threads as { total: number; current: number; running: number };
    console.log(`running · pid ${status.pid} · uptime ${formatDuration(Number(status.uptimeSeconds) * 1000)}`);
    console.log(`dashboard: ${dashboardUrl(status.dashboard as { host: string; port: number })}`);
    console.log(`${status.workspaces} workspaces · ${channels.healthy}/${channels.total} channels healthy · ${threads.current} current threads · ${threads.running} running`);
    return true;
  }

  if (command === "workspaces") {
    const args = [...inputArgs];
    const json = takeFlag(args, "--json");
    const name = args.shift();
    rejectArgs(args);
    if (name) {
      const workspace = await api<WorkspaceView>(`/workspaces/${encodeURIComponent(name)}`);
      if (json) return printJson(workspace);
      printWorkspace(workspace, true);
    } else {
      const workspaces = await api<WorkspaceView[]>("/workspaces");
      if (json) return printJson(workspaces);
      for (const [index, workspace] of workspaces.entries()) {
        if (index) console.log();
        printWorkspace(workspace, false);
      }
    }
    return true;
  }

  if (command !== "threads") return false;
  const args = [...inputArgs];
  const action = args[0];
  if (action === "invoke") {
    args.shift();
    let workspace: string | undefined;
    let detach = false;
    let json = false;
    while (args[0]?.startsWith("--")) {
      const option = args.shift();
      if (option === "--") break;
      if (option === "--workspace") workspace = requiredValue(args, option);
      else if (option === "--detach") detach = true;
      else if (option === "--json") json = true;
      else throw new Error(`unknown option ${option}`);
    }
    if (!workspace) throw new Error("threads invoke requires --workspace <name>");
    const message = await messageFrom(args);
    const thread = await api<ThreadView>("/threads", {
      method: "POST",
      body: { workspace, text: message, source: "cli" },
    });
    if (detach) {
      if (json) return printJson(thread);
      console.log(`invoked thread ${thread.id.slice(0, 8)} · ${workspace} · detached`);
      return true;
    }
    const run = await waitForRun(thread.id, 30 * 60_000);
    if (run.status === "error") throw new Error(`${run.error || "turn failed"} (thread ${thread.id.slice(0, 8)})`);
    const response = { thread, result: run.result };
    if (json) return printJson(response);
    console.log(`thread: ${thread.id.slice(0, 8)} · ${workspace}${run.result?.model ? ` · ${run.result.model}` : ""}\n`);
    console.log(run.result?.text ?? "");
    return true;
  }

  if (action === "send") {
    args.shift();
    const ref = args.shift();
    let json = false;
    while (args[0]?.startsWith("--")) {
      const option = args.shift();
      if (option === "--") break;
      if (option === "--json") json = true;
      else throw new Error(`unknown option ${option}`);
    }
    if (!ref) throw new Error("threads send requires a thread id");
    const message = await messageFrom(args);
    const response = await api<Json>(`/threads/${encodeURIComponent(ref)}/send`, {
      method: "POST",
      body: { text: message },
      timeoutMs: 5 * 60_000,
    });
    if (json) return printJson(response);
    const target = response.target as { bot: string; chatId: number; topic?: number };
    console.log(`sent → telegram/${target.bot} · ${target.chatId}${target.topic === undefined ? "" : ` · topic ${target.topic}`}`);
    console.log(`thread: ${String(response.threadId).slice(0, 8)}`);
    if (response.recorded === false) console.warn(`warning: ${response.warning}`);
    return true;
  }

  const json = takeFlag(args, "--json");
  const all = takeFlag(args, "--all");
  const running = takeFlag(args, "--running");
  const workspace = takeOption(args, "--workspace");
  const channel = takeOption(args, "--channel");
  const since = takeOption(args, "--since");
  const limit = takeOption(args, "--limit");
  const ref = args.shift();
  rejectArgs(args);

  if (ref) {
    if (all || running || workspace || channel || since || limit) {
      throw new Error("thread list filters cannot be combined with a thread id");
    }
    const detail = await api<{ thread: ThreadView }>(`/threads/${encodeURIComponent(ref)}`);
    if (json) return printJson(detail);
    printThread(detail.thread);
    return true;
  }

  const params = new URLSearchParams();
  if (!all) params.set("current", "1");
  if (running) params.set("running", "1");
  if (workspace) params.set("workspace", workspace);
  if (channel) params.set("channel", channel);
  if (since) params.set("since", String(parseSince(since)));
  if (limit) params.set("limit", String(parsePositiveInteger(limit, "limit")));
  const threads = await api<ThreadView[]>(`/threads?${params}`);
  if (json) return printJson(threads);
  printThreads(threads);
  return true;
}

function printWorkspace(workspace: WorkspaceView, detail: boolean) {
  console.log(`${workspace.name}${workspace.pathExists ? "" : "  ⚠ missing path"}`);
  console.log(`  ${shortPath(workspace.path)}`);
  console.log(`  model: ${workspace.model} (${workspace.modelSource}) · thinking: ${workspace.thinking}`);
  console.log(`  tools: ${workspace.tools.join(", ") || "none"}`);
  if (workspace.channels.length) {
    console.log(`  channels: ${workspace.channels.map((channel) => `${channel.type}/${channel.name}${channel.username ? ` (@${channel.username})` : ""}${channel.connected ? "" : " ⚠"}`).join(", ")}`);
  } else {
    console.log("  channels: none");
  }
  console.log(`  threads: ${workspace.threads.current} current · ${workspace.threads.running} running · ${workspace.threads.total} total`);
  if (!detail) return;
  console.log(`  fallbacks: ${workspace.fallbacks.join(", ") || "none"}`);
  console.log(`  custom prompt: ${workspace.customPrompt ? "yes" : "no"}`);
  console.log(`  session: idle reset ${workspace.session.idleDays}d · retention ${workspace.session.retentionDays}d`);
  console.log(`  skills: ${workspace.skills?.length ?? 0}${workspace.skills?.length ? ` (${workspace.skills.map((skill) => skill.name).join(", ")})` : ""}`);
  for (const channel of workspace.channels) {
    console.log(`\n  ${channel.type}/${channel.name}`);
    console.log(`    status: ${channel.connected ? "healthy" : "unhealthy"}${channel.username ? ` · @${channel.username}` : ""}`);
    console.log(`    users: ${channel.users} · groups: ${channel.groups}`);
  }
}

function printThreads(threads: ThreadView[]) {
  if (!threads.length) {
    console.log("no threads");
    return;
  }
  const rows = threads.map((thread) => [
    thread.id.slice(0, 8),
    thread.workspace,
    truncate(thread.conversation, 38),
    thread.state,
    timeAgo(thread.lastActivityAt),
  ]);
  printTable(["ID", "WORKSPACE", "CONVERSATION", "STATE", "UPDATED"], rows);
}

function printThread(thread: ThreadView) {
  console.log(thread.id);
  console.log("\nConversation");
  console.log(`  source: ${thread.source}`);
  console.log(`  session: ${thread.sessionKey}`);
  console.log(`  title: ${thread.title ?? "(untitled)"}`);
  console.log(`  display: ${thread.conversation}`);
  console.log(`  workspace: ${thread.workspace}`);
  console.log(`  current: ${thread.current ? "yes" : "no"}`);
  console.log(`  running: ${thread.running ? "yes" : "no"}`);
  console.log("\nRuntime");
  console.log(`  model override: ${thread.model ?? "none"}`);
  console.log(`  effective model: ${thread.effectiveModel ?? "unknown"}`);
  console.log(`  last model used: ${thread.lastModel ?? "none"}`);
  console.log(`  created: ${formatDate(thread.createdAt)}`);
  console.log(`  last activity: ${timeAgo(thread.lastActivityAt)}`);
  console.log("\nSession");
  console.log(`  messages: ${thread.messages ?? 0}`);
  console.log(`  turns: ${thread.turns ?? 0}`);
  console.log(`  file: ${thread.sessionFile ? shortPath(thread.sessionFile) : "none"}`);
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));
  console.log(headers.map((header, i) => header.padEnd(widths[i])).join("  "));
  for (const row of rows) console.log(row.map((value, i) => value.padEnd(widths[i])).join("  "));
}

async function waitForRun(threadId: string, timeoutMs: number): Promise<CliRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await api<CliRun>(`/threads/${threadId}/run`);
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for thread ${threadId.slice(0, 8)}; it may still be running`);
}

async function api<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const config = new ConfigStore().resolved.dashboard;
  const url = `http://${urlHost(config.host)}:${config.port}/api${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new Error(`cannot reach eleven at ${dashboardUrl(config)}: ${error instanceof Error ? error.message : error}`);
  }
  const payload = await response.json().catch(() => ({})) as T & { error?: string; threadId?: string };
  if (!response.ok) {
    const thread = payload.threadId ? ` (thread ${payload.threadId.slice(0, 8)})` : "";
    throw new Error(`${payload.error || `eleven returned HTTP ${response.status}`}${thread}`);
  }
  return payload;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function rejectArgs(args: string[]) {
  if (args.length) throw new Error(`unexpected argument${args.length > 1 ? "s" : ""}: ${args.join(" ")}`);
}

function requiredValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function messageFrom(args: string[]): Promise<string> {
  const message = args.length ? args.join(" ") : !process.stdin.isTTY ? await readStream(process.stdin) : "";
  if (!message.trim()) throw new Error("message is required (argument or stdin)");
  return message;
}

function parseSince(value: string): number {
  const match = value.match(/^(\d+)(m|h|d|w)$/);
  if (match) {
    const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
    return Date.now() - Number(match[1]) * units[match[2] as keyof typeof units];
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid --since value ${value}; use 30m, 24h, 7d, or an ISO date`);
  return timestamp;
}

function parsePositiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function printJson(value: unknown): true {
  console.log(JSON.stringify(value, null, 2));
  return true;
}

function dashboardUrl(config: { host: string; port: number }): string {
  return `http://${urlHost(config.host)}:${config.port}`;
}

function urlHost(configured: string): string {
  const host = configured === "0.0.0.0" ? "127.0.0.1" : configured === "::" ? "::1" : configured;
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function shortPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function timeAgo(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

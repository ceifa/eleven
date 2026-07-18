import { authStorage } from "./agent/pi.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;

type RawUsageWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
};

type CodexUsageResponse = {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: RawUsageWindow | null;
    secondary_window?: RawUsageWindow | null;
  };
  credits?: {
    balance?: unknown;
  };
};

interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
}

export interface ProviderUsage {
  provider: string;
  plan?: string;
  windows: UsageWindow[];
  credits?: number;
}

/** Fetch the subscription quota for the provider behind a model reference. */
export async function fetchProviderUsage(modelRef: string): Promise<ProviderUsage> {
  const provider = modelRef.split("/", 1)[0];
  if (provider !== "openai-codex") {
    throw new Error(`subscription usage is not available for ${provider}`);
  }

  const token = await authStorage.getApiKey(provider);
  if (!token) throw new Error(`${provider} is not authenticated`);

  // getApiKey may refresh OAuth and update the stored credential, so read the
  // account id afterwards. ChatGPT team accounts need this header for the
  // correct subscription quota.
  const credential = authStorage.get(provider);
  const accountId = credential?.type === "oauth" && typeof credential.accountId === "string"
    ? credential.accountId
    : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    originator: "eleven",
    "User-Agent": "eleven",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  let response: Response;
  try {
    response = await fetch(CODEX_USAGE_URL, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`OpenAI usage request failed: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenAI login expired — run `pi` and `/login`");
    }
    throw new Error(`OpenAI usage request returned HTTP ${response.status}`);
  }

  let data: CodexUsageResponse;
  try {
    data = await response.json() as CodexUsageResponse;
  } catch {
    throw new Error("OpenAI returned an invalid usage response");
  }

  const windows = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]
    .flatMap((window) => parseWindow(window));
  const balance = finiteNumber(data.credits?.balance);
  const plan = typeof data.plan_type === "string" && data.plan_type.trim()
    ? titleCase(data.plan_type)
    : undefined;

  if (!windows.length && balance === undefined) {
    throw new Error("OpenAI did not report any subscription limits");
  }
  return {
    provider: "OpenAI Codex",
    plan,
    windows,
    ...(balance !== undefined && balance >= 0 ? { credits: balance } : {}),
  };
}

export function formatProviderUsage(usage: ProviderUsage, now = Date.now()): string {
  const title = `**${usage.provider}${usage.plan ? ` · ${usage.plan}` : ""}**`;
  const lines = usage.windows.map((window) => {
    const left = Math.max(0, 100 - window.usedPercent);
    const reset = window.resetAt ? ` · resets ${formatRelativeTime(window.resetAt, now)}` : "";
    return `- **${window.label}:** ${formatNumber(left)}% left${reset}`;
  });
  if (usage.credits !== undefined) lines.push(`- **Credits:** ${formatNumber(usage.credits)} left`);
  return [title, ...lines].join("\n");
}

function parseWindow(raw: RawUsageWindow | null | undefined): UsageWindow[] {
  if (!raw) return [];
  const usedPercent = finiteNumber(raw.used_percent);
  if (usedPercent === undefined) return [];
  const seconds = finiteNumber(raw.limit_window_seconds);
  const resetAtSeconds = finiteNumber(raw.reset_at);
  const resetAfterSeconds = finiteNumber(raw.reset_after_seconds);
  const resetAt = resetAtSeconds !== undefined
    ? resetAtSeconds * 1000
    : resetAfterSeconds !== undefined
      ? Date.now() + resetAfterSeconds * 1000
      : undefined;
  return [{
    label: windowLabel(seconds),
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetAt,
  }];
}

function windowLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "Limit";
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 7 && hours % (24 * 7) === 0) {
    const weeks = hours / (24 * 7);
    return weeks === 1 ? "Week" : `${weeks} weeks`;
  }
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "Day" : `${days} days`;
  }
  return `${hours}h`;
}

function formatRelativeTime(target: number, now: number): string {
  let minutes = Math.max(0, Math.ceil((target - now) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  minutes -= days * 24 * 60;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  if (days) return `in ${days}d ${hours}h`;
  if (hours) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function titleCase(value: string): string {
  return value.trim().replace(/(^|[_\s-])\p{L}/gu, (match) => match.toUpperCase()).replaceAll("_", " ");
}

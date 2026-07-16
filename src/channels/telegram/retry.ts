import { GrammyError } from "grammy";
import { logger } from "../../log.ts";

const log = logger("telegram/retry");

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

/** Errors that provably happened before the request reached Telegram. */
const PRE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function preConnect(error: unknown): boolean {
  const cause = (error as { error?: unknown })?.error ?? error;
  const code = (cause as { code?: string })?.code ?? ((cause as Error)?.cause as { code?: string })?.code;
  return code !== undefined && PRE_CONNECT_CODES.has(code);
}

/** Flood-wait duration from a Telegram 429, capped. */
export function retryAfterMs(error: unknown, capMs = RETRY_AFTER_CAP_MS): number | undefined {
  const seconds = (error as GrammyError)?.parameters?.retry_after;
  return typeof seconds === "number" ? Math.min(seconds * 1000, capMs) : undefined;
}

function transient(error: unknown): boolean {
  if (error instanceof GrammyError) return error.error_code === 429 || error.error_code >= 500;
  return true; // network-level errors
}

/** Errors that mean "already in the desired state" — safe to ignore. */
export function isNoop(error: unknown): boolean {
  const description = (error as GrammyError)?.description ?? "";
  return /message is not modified|message to delete not found|there is no text in the message to edit|REACTION_INVALID/i.test(
    description,
  );
}

/**
 * Retry a Telegram API call. `send` mode only retries errors that provably
 * happened pre-connect — an ambiguous failure after a send may have delivered a
 * visible message, and a duplicate is worse than a gap. Idempotent calls
 * (edits, reactions, deletes) retry on any transient error.
 */
export async function withRetry<T>(kind: "send" | "idempotent", label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retriable = kind === "send" ? preConnect(error) || retryAfterMs(error) !== undefined : transient(error);
      if (!retriable || attempt === MAX_ATTEMPTS) throw error;
      const delay = retryAfterMs(error) ?? Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      log.warn(`${label} failed (attempt ${attempt}), retrying in ${delay}ms: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

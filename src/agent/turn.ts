import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ModelEntry, WorkspaceTool } from "../config.ts";
import type { RecordedToolCall } from "../threads/reader.ts";
import type { BackgroundStatusFactory } from "./host-api.ts";
import type { PanelUpdate } from "./panels.ts";
import type { PromptConfig, RuntimeContext } from "./system-prompt.ts";

/* What a turn is, as everything outside the runner sees it: the request that
   starts one, the events it reports while it runs, and how it ends. */

/** Everything needed to reach a conversation's pi session on disk. */
export interface SessionTarget {
  /** Absolute path of the pi session file; absent when none was ever created. */
  sessionFile?: string;
  sessionDir: string;
  workspacePath: string;
}

export interface TurnRequest extends SessionTarget {
  runtime: RuntimeContext;
  /** Ordered candidates: primary first, then fallbacks — each with its own
   * reasoning level and tool allowlist. */
  models: ModelEntry[];
  /** Provider-neutral workspace capability allowlist; undefined enables the curated default. */
  tools?: WorkspaceTool[];
  /** Runtime-native tools this workspace withholds — it supplies its own. */
  excludeNativeTools?: string[];
  customTools?: ToolDefinition[];
  /** Resolved prompt for this turn (workspace system prompt + channel appends). */
  prompt?: PromptConfig;
  text: string;
  images?: ImageContent[];
  /** Discard a failed attempt before this turn starts — a manual restart runs
   * the request as if it had never been tried. */
  rewind?: TurnRewind;
  /** Whether the conversation may be compacted while it sits idle (see
   * scheduleIdleCompaction) — asked again when the time comes. Absent means never. */
  compactWhenIdle?: () => boolean;
  /** Channel delivery of the finished turn. Runs inside the thread's turn lane
   * (before onTurnEnd fires and before the next queued turn can start), so a
   * durable handoff can replace generation recovery with literal delivery. */
  deliver?: (result: TurnResult) => Promise<void>;
  /** Start a later turn in this conversation (see host-api.ts). */
  wake?: (text: string) => Promise<void>;
  sessionSignal?: AbortSignal;
  createBackground?: BackgroundStatusFactory;
}

export interface TurnEvents {
  /** Streamed assistant text delta. */
  onDelta?: (delta: string) => void;
  /** A complete assistant message finished (text may be empty for tool-only messages). */
  onAssistantText?: (text: string) => void;
  /** Prose the runtime settled mid-turn, while its own tool loop kept running —
   * what the model said before going back to work, not the turn's answer. The
   * channel ships it right away; the answer still arrives through `deliver`. */
  onProse?: (text: string) => void;
  /** An answer to the message the turn started with, settled while a message
   * that arrived mid-turn is still waiting for its own. A channel that ships it
   * now keeps the two replies in the order they were asked for; one that
   * ignores this still receives both through `deliver`. */
  onEarlyAnswer?: (text: string) => void;
  /** The attempt failed and is retrying on a fallback model — its prose is abandoned. */
  onFailover?: () => void;
  /** A retryable provider error (529, stream drop) and the runtime is running the
   * same turn again. Minutes of silence otherwise indistinguishable from thinking. */
  onRetry?: (notice: RetryNotice) => void;
  /** Raw pi event passthrough (channel lifecycle handling). */
  onEvent?: (event: AgentSessionEvent) => void;
  /** Provider-neutral tool activity for the dashboard. `id` is the call's
   *  durable id — pi's toolCallId, or the id the nested-runtime record was
   *  written under — so a live row can open the same detail view (args, and
   *  the result once it lands) a persisted one does. */
  onToolCall?: (name: string, args: Record<string, unknown>, id: string) => void;
  /** A producer replaced the panels it shows (see panels.ts). */
  onPanels?: (update: PanelUpdate) => void;
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
}

export interface TurnResult {
  sessionFile: string;
  /** All assistant prose produced this turn, message boundaries joined by blank lines. */
  text: string;
  model: string;
  status: "completed" | "stopped";
}

/**
 * A turn that gave up with candidates still untried. The runner never fails over
 * automatically once an attempt ran tools — a transcript rewind cannot undo a
 * Bash command, an edit or a sent message — so the untried tail is handed to the
 * channel, which can offer the person a manual failover instead of a dead end.
 */
export class TurnFailure extends Error {
  readonly failedModel: string;
  /** Plan entries after the one that stopped the turn, in order. */
  readonly remaining: ModelEntry[];
  /** The branch a restart of this turn would rewind, filled in once the failure
   * is recorded (that record is what `from` has to still point at). */
  rewind?: TurnRewind;
  /** Isolated nested calls that are display-only, unlike the owning runtime's
   * tool history. A continuation must be told about side effects it cannot see. */
  hiddenToolCalls: RecordedToolCall[] = [];

  constructor(message: string, failedModel: string, remaining: ModelEntry[]) {
    super(message);
    this.name = "TurnFailure";
    this.failedModel = failedModel;
    this.remaining = remaining;
  }
}

/**
 * Branch a failed attempt away before running its turn again: navigate back to
 * `to`, but only while the session's leaf is still `from`. Anything appended
 * since (a turn run from the dashboard, say) sits on the branch the rewind would
 * discard — leaving it alone costs a duplicated request, dropping it costs a
 * conversation.
 */
export interface TurnRewind {
  from: string;
  to: string;
}

/**
 * The error a failed turn throws: a `TurnFailure` when the plan had candidates
 * after the one that stopped it, the plain error when the plan is exhausted
 * (nothing left to offer).
 */
export function turnFailure(error: unknown, plan: ModelEntry[], stoppedAt: number): Error {
  const failure = error instanceof Error ? error : new Error(error ? String(error) : "all models failed");
  const remaining = plan.slice(stoppedAt + 1);
  const failed = plan[stoppedAt]?.model;
  if (!remaining.length || !failed) return failure;
  return new TurnFailure(failure.message, failed, remaining);
}

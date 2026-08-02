import { CLAUDE_SESSIONS_FILE } from "../paths.ts";
import { readJsonFile, writeJsonFile } from "../util.ts";

interface ActiveAttempt {
  id: string;
  inputHash: string;
  inputCount: number;
  toolActivity: boolean;
  /** Interrupted parent restored if this resume fork fails before any tool. */
  parent?: ActiveAttempt;
}

interface SessionState {
  cwd: string;
  committed?: string;
  active?: ActiveAttempt;
  /** Includes active/committed ids. */
  sessions: string[];
  /** Files no longer live but retained until deletion is acknowledged. */
  garbage?: string[];
}

interface StoreShape {
  version: 1;
  sessions: Record<string, SessionState>;
}

/** Tiny synchronous durability boundary. begin()/markTool() must hit disk before
 * Claude can perform a side effect, otherwise a daemon crash could replay it. */
class ClaudeSessionStateStore {
  private data = readJsonFile<StoreShape>(CLAUDE_SESSIONS_FILE, { version: 1, sessions: {} });

  get(piSessionId: string): SessionState | undefined {
    return this.data.sessions[piSessionId];
  }

  begin(piSessionId: string, cwd: string, attempt: Omit<ActiveAttempt, "toolActivity">): void {
    const state = (this.data.sessions[piSessionId] ??= { cwd, sessions: [] });
    state.cwd = cwd;
    state.active = { ...attempt, toolActivity: false, ...(state.active ? { parent: state.active } : {}) };
    if (!state.sessions.includes(attempt.id)) state.sessions.push(attempt.id);
    this.persist();
  }

  markTool(piSessionId: string): void {
    const active = this.data.sessions[piSessionId]?.active;
    if (!active || active.toolActivity) return;
    active.toolActivity = true;
    this.persist();
  }

  /** Commit the successful fork and return session ids now safe to delete. */
  commit(piSessionId: string, attemptId: string): string[] {
    const state = this.data.sessions[piSessionId];
    if (!state) return [];
    const stale = state.sessions.filter((id) => id !== attemptId);
    state.committed = attemptId;
    state.active = undefined;
    state.sessions = [attemptId];
    state.garbage = [...new Set([...(state.garbage ?? []), ...stale])];
    this.persist();
    return [...state.garbage];
  }

  /** Clear a side-effect-free failed attempt and return its id for deletion.
   * Toolful attempts remain active so a restart/next message can resume them. */
  fail(piSessionId: string, attemptId: string): { toolActivity: boolean; removable: string[] } {
    const state = this.data.sessions[piSessionId];
    const active = state?.active?.id === attemptId ? state.active : undefined;
    if (!state || !active) return { toolActivity: false, removable: [attemptId] };
    if (active.toolActivity) return { toolActivity: true, removable: [] };
    state.active = active.parent;
    state.sessions = state.sessions.filter((id) => id !== attemptId);
    state.garbage = [...new Set([...(state.garbage ?? []), attemptId])];
    this.persist();
    return { toolActivity: false, removable: [...state.garbage] };
  }

  /** Mark an entire Eleven thread for cleanup without forgetting failed deletions. */
  remove(piSessionId: string): SessionState | undefined {
    const state = this.data.sessions[piSessionId];
    if (!state) return undefined;
    state.garbage = [...new Set([...(state.garbage ?? []), ...state.sessions])];
    state.sessions = [];
    state.active = undefined;
    state.committed = undefined;
    this.persist();
    return state;
  }

  garbageEntries(): { sessionId: string; cwd: string; ids: string[] }[] {
    return Object.entries(this.data.sessions).flatMap(([sessionId, state]) =>
      state.garbage?.length ? [{ sessionId, cwd: state.cwd, ids: [...state.garbage] }] : [],
    );
  }

  ackDeleted(piSessionId: string, ids: string[]): void {
    const state = this.data.sessions[piSessionId];
    if (!state || !ids.length) return;
    const deleted = new Set(ids);
    state.garbage = (state.garbage ?? []).filter((id) => !deleted.has(id));
    if (!state.active && !state.committed && state.sessions.length === 0 && state.garbage.length === 0) {
      delete this.data.sessions[piSessionId];
    }
    this.persist();
  }

  private persist(): void {
    writeJsonFile(CLAUDE_SESSIONS_FILE, this.data);
  }
}

export const claudeSessionState = new ClaudeSessionStateStore();

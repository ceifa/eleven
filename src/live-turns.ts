import { PanelBoard, type Panel, type PanelUpdate } from "./agent/panels.ts";

// In-memory activity of a running turn, so a dashboard opened mid-turn can
// catch up on what already happened (WS events only reach pages already open).
// It records prose, tool calls and provider requests *in order*: tool calls are
// also persisted to the session file, but the streamed prose is not, so the
// on-disk transcript alone can't say whether text came before or after a call.
const LIVE_TEXT_MAX_CHARS = 64_000;
const LIVE_ITEMS_MAX = 400;

export type LiveItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; args?: Record<string, unknown>; at: number }
  | { kind: "request"; id: string; model: string; at: number }
  // A message that arrived while the turn was running and was steered into it.
  // It is persisted immediately too, but only the live record knows *where* in
  // the turn it landed — the transcript cannot see the streamed prose it fell
  // between.
  | { kind: "message"; role: "user" | "assistant"; text: string; at: number };

interface LiveTurn {
  startedAt: number;
  /** What the turn has produced so far, oldest first. */
  items: LiveItem[];
  /** Streamed characters kept so far, against LIVE_TEXT_MAX_CHARS. */
  chars: number;
  /** The panels the turn's producers show. Unlike `items` this is state, not a
   *  log: a page opened mid-turn needs them as they stand, not the updates that
   *  built them — so the whole set is what gets broadcast and served. */
  panels: PanelBoard;
}

/** The live turn as the dashboard consumes it (a board is not JSON on its own). */
export interface LiveTurnView {
  startedAt: number;
  items: LiveItem[];
  panels: Panel[];
}

/** The record of every turn running right now, by thread. */
export class LiveTurns {
  private turns = new Map<string, LiveTurn>();

  /** The thread's record, opened if it has none: by the message that is about
   *  to start a turn, or by a turn nobody opened one for (a woken one). */
  open(threadId: string): LiveTurnView {
    let live = this.turns.get(threadId);
    if (!live) this.turns.set(threadId, (live = { startedAt: Date.now(), items: [], chars: 0, panels: new PanelBoard() }));
    return view(live);
  }

  get(threadId: string): LiveTurnView | undefined {
    const live = this.turns.get(threadId);
    return live && view(live);
  }

  end(threadId: string): void {
    this.turns.delete(threadId);
  }

  /** Append to the running turn's record, oldest entries falling off first so
   *  a very long turn can't grow it without bound. */
  push(threadId: string, item: LiveItem): void {
    const live = this.turns.get(threadId);
    if (!live) return;
    live.items.push(item);
    // Dropped tool calls still reach a reloading page: they're persisted in the
    // session file, so they simply render as part of the durable transcript.
    if (live.items.length > LIVE_ITEMS_MAX) live.items.splice(0, live.items.length - LIVE_ITEMS_MAX);
  }

  /** Streamed prose, up to the cap. */
  text(threadId: string, delta: string): void {
    const live = this.turns.get(threadId);
    if (!live || live.chars >= LIVE_TEXT_MAX_CHARS) return;
    live.chars += delta.length;
    // Prose after a tool call is a new paragraph of the turn, not a
    // continuation of the last one — that's what keeps the order readable.
    const last = live.items.at(-1);
    if (last?.kind === "text") last.text += delta;
    else this.push(threadId, { kind: "text", text: delta });
  }

  /** A failover rewound the transcript to the start of the turn: whatever the
   *  failed attempt streamed is off the surviving branch. */
  rewind(threadId: string): void {
    const live = this.turns.get(threadId);
    if (!live) return;
    live.items = [];
    live.chars = 0;
  }

  /** Apply one producer's update; the whole set as it now stands, or undefined
   *  when no turn is running to show it. */
  panels(threadId: string, update: PanelUpdate): Panel[] | undefined {
    const live = this.turns.get(threadId);
    if (!live) return undefined;
    live.panels.apply(update);
    return live.panels.panels;
  }
}

function view(live: LiveTurn): LiveTurnView {
  return { startedAt: live.startedAt, items: live.items, panels: live.panels.panels };
}

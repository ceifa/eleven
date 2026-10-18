# Panels

While a turn runs, eleven shows a status card: whether the agent is working,
the tool it is running, provider retries. Anything else on that card, such as
a plan, the agents of a fan-out or the stages of a pipeline, is a **panel**,
and eleven does not know what any of them mean. A workspace extension or a tool
publishes panels; Telegram, the dashboard and any future channel draw them.

This page is the contract.

## Why it works this way

eleven ships the gateway, not opinions about how to work. A checklist and a
fan-out orchestrator are ways of working, so they belong to the workspace that
wants them, along with all of their meaning: which rows are worth sending,
what goes in the note beside a row, how a blocker reads, when a finished row
stops being interesting.

So the contract is a small piece of display vocabulary, not a per-feature
integration and not markup. Producers describe panels and each channel decides
how to draw them. A producer never has to know which channel is listening, and
a new channel works with every existing producer without either changing.

Rejected: letting an extension render per channel. It would make every
extension know every channel, and the first new channel would break all of
them.

## The vocabulary

```ts
interface Panel {
  title: string;
  icon?: string;   // a glyph a channel may put before the title
  rows: Row[];
  more?: number;   // rows you left out
  quiet?: boolean; // carried over, not produced by this turn
}

interface Row {
  text: string;
  state: "idle" | "waiting" | "active" | "done" | "failed" | "stopped";
  note?: string;              // one line of context beside the text
  detail?: [string, string][]; // label/value pairs a channel may open on demand
}
```

Each channel turns `state` into an icon. Everything a row says beyond that is
`text`, `note` and `detail`, formatted by the producer.

A report is the whole list of panels a producer shows right now. It replaces
that producer's previous report and nothing else. An empty list clears it.

### Scope

Every producer has a **scope**, which is what makes its report authoritative
over its own panels only. Without it, the first producer to report would wipe
everything else off the card. A tool call gets its call id as its scope
automatically; an extension reporting outside a tool names its own.

### What eleven still decides

- A panel is drawn only if it has rows, or says it left some out.
- A channel caps the rows it draws. Telegram drops finished rows first, oldest
  first, and counts them on one line.
- `quiet` panels are drawn, but they never cause a status message to be posted.
  Use it for work carried over from an earlier turn: worth showing, not worth a
  notification.
- When a turn is stopped or fails, every `active` row is shown as `stopped`.
  Nobody is working on it any more, and the producer may be what died.
- A tool that publishes panels loses its argument preview on the status line.
  Its rows say more than a truncated argument could.

## Publishing from a tool

The fourth argument of a tool's `execute` is an update callback. Put the panels
in `details.panels`.

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  onUpdate?.({
    content: [{ type: "text", text: "working" }],
    details: { panels: [{ title: "Phases", rows: [{ text: "Scouting", state: "active" }] }] },
  });
  // …
}
```

This works on every provider: for pi's own loop it arrives as
`tool_execution_update`, and for a nested runtime eleven holds the callback
itself across the MCP bridge. An untitled panel is titled with the tool's name.

## Publishing outside a tool

A pi extension can otherwise only speak from inside `execute`, which does not
help when it wants to draw something on `turn_start`. eleven publishes a
handshake for that:

```ts
interface ElevenHost {
  version: 2;
  panels(panels: unknown, options?: { scope?: string }): boolean;
}

globalThis.eleven?.panels(panels, { scope: "tasks" });
```

It returns `false` when nothing is listening (under plain pi, or outside a
turn), so the same extension file keeps working with no host at all. Reports
are routed to the conversation whose turn is on the call stack; there is
nothing to pass and nothing to look up.

It is on `globalThis` rather than an import because pi loads workspace
extensions itself, and an extension in a workspace directory has no import
path back to whichever eleven is hosting it. `version` is there so you can
feature-detect rather than guess.

This grants no authority a workspace extension did not already have: it runs
in-process with the tools the workspace granted it. Everything it sends is
validated exactly like a tool's report, and anything malformed is dropped, so
publishing a panel can never fail the code that publishes it.

## Delegation is not a capability

Claude Code's `Agent`, `SendMessage` and its own
`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` are never granted to any
workspace, so nothing the runtime brings competes with what a workspace ships.

A native subagent runs as a session eleven does not own. Extension tools are
bridged into it, but the spawned agent gets a session identity of its own: an
extension that keys state per conversation forks that state without knowing,
then reports the fork under the parent's scope, where it replaces the parent's
panels. Nothing in the capability vocabulary can say "the same conversation"
across that boundary. A workspace that wants fan-out ships it as an extension
tool, where it has one identity and one place to report from.

`excludeNativeTools` remains for everything else: a workspace withholds any
native by name when it supplies its own.

```jsonc
{
  "workspaces": {
    "mine": {
      "path": "~/work",
      "excludeNativeTools": ["WebSearch"]
    }
  }
}
```

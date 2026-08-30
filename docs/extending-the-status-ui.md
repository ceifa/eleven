# Extending the turn's status UI

A turn's chat status — the plan, the roster of subagents, what is running right
now — is drawn by eleven but **not owned by it**. Anything a workspace teaches
the agent to do can draw its own rows there, in Telegram and in the dashboard,
without eleven learning what that thing is.

This page is the contract.

## Why it works this way

A gateway should ship the substrate, not the opinions. A checklist, a fan-out
orchestrator, a research pipeline — those are ways of working, and they belong
to the workspace that wants them. eleven's job is to make them visible.

So the contract is **data**, not markup, and not a per-feature integration:
producers describe rows, each channel decides how to draw them. A Telegram
message and a web page have nothing in common except the shape of what they are
being told, and an extension should not have to know which one is listening.

## The vocabulary

```ts
type ActivityEvent =
  // An authoritative snapshot of this producer's rows. `seeded` marks work
  // carried over from an earlier turn: drawn, but never worth interrupting for.
  | { kind: "plan"; tasks: Item[]; seeded?: boolean }
  // One row, merged into the row with the same id.
  | { kind: "agent"; task: Item }
  // How many exist, when you cap how many you send (see "Capping", below).
  | { kind: "agents"; total: number };

interface Item {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  blockedBy?: string[];
  summary?: string;
  lastToolName?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}
```

Two families, because two things are worth watching: **work to be done** (a
plan, whose rows change state) and **work being done in parallel** (agents,
which report as they run). A `plan` event replaces every row of its producer;
an `agent` event merges into the one it names.

### Scope and label

Every producer has a **scope**: an identifier that keeps its ids from colliding
with anyone else's and makes its snapshots authoritative over its own rows only.
Without it, the first extension to report would wipe everything else off the
screen.

**Label** is how the scope is titled where a person reads it. Pick a noun the
reader recognises, not your module name.

Ids are namespaced under the scope on the way in (`plan:1` becomes
`tasks:plan:1`) and shown without it. Report the id you were handed and it will
not be namespaced twice.

## Reporting from a tool

The fourth argument of a tool's `execute` is an update callback. Attach the
events to `details.activity`; scope and label are filled in from the call.

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  onUpdate?.({
    content: [{ type: "text", text: "working" }],
    details: {
      activity: [
        { kind: "plan", tasks: [{ id: "scout", title: "Scouting", status: "running" }] },
      ],
    },
  });
  // …
}
```

This works on every provider: for pi's own loop it arrives as
`tool_execution_update`, and for a nested runtime eleven holds the callback
itself across the MCP bridge.

A tool that reports this way loses its argument preview in the status line — its
rows say more than a truncated argument ever could.

## Reporting outside a tool

A pi extension can otherwise only speak from inside `execute`, which is no use
for drawing something on `turn_start`. eleven publishes a handshake for that:

```ts
interface ElevenHost {
  version: number;
  activity(events: unknown, options?: { scope?: string; label?: string }): boolean;
}

const eleven = (globalThis as { eleven?: ElevenHost }).eleven;
eleven?.activity(events, { scope: "tasks", label: "Plan" });
```

It returns `false` when nothing is listening — under plain pi, or outside a turn
— so the same extension file keeps working with no host at all. Reports are
routed to the conversation whose turn is on the call stack; there is nothing to
pass and nothing to look up.

`globalThis` rather than an import because pi loads workspace extensions itself,
decides what context they get, and an extension in a workspace directory has no
import path back to whichever eleven is hosting it. `version` is there so you
can feature-detect rather than guess.

This grants no authority a workspace extension did not already have: it runs
in-process with the tools the workspace granted it. Everything it sends is
validated exactly like a tool's report, and anything malformed is dropped —
reporting progress can never fail the thing reporting.

## Capping

A fan-out can spawn hundreds of agents and a channel draws a handful, so send
the interesting ones — the running ones first, then the most recently finished —
and say how many exist with `{ kind: "agents", total }`.

Do not skip the total. Without it the channel counts the rows that arrived and
tells the reader "… 2 more" when forty agents ran.

## Replacing what the runtime ships

Claude Code brings its own plan and its own subagents. A workspace that supplies
its own should withhold them, or the model gets two of each and has to choose:

```jsonc
{
  "workspaces": {
    "mine": {
      "path": "~/work",
      "excludeNativeTools": ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]
    }
  }
}
```

Withholding is by tool name and per workspace. eleven ships the natives; the
workspace decides whether it wants them.

Extension tools reach Claude's own subagents: eleven bridges them over SDK-MCP
with `alwaysLoad`, and a spawned agent carries them in its tool set. Measured,
not assumed — so a plan you own is visible to the subagents that should be
reading it.

## Worked example

The plan and the fan-out orchestrator this was built for live outside eleven, in
their own workspace, as ordinary extensions: `tasks.ts` (a checklist with
dependencies, persisted per conversation, seeded into each turn on
`turn_start`) and `workflows.ts` (a scripted fan-out that reports its phases as
a plan and its subagents as agents). Neither is in this repository, and eleven
does not know either of them exists.

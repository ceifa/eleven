# Panels

While a turn runs, eleven shows a status card with the turn's state, the tool
it is running and any provider retries. Everything else on the card is a
**panel**, published by a workspace extension or a tool. A plan, the agents of
a fan-out and the stages of a pipeline are all panels, and eleven doesn't know
which is which. Telegram and the dashboard draw them, and so will any channel
added later.

## Why it works this way

How a workspace organizes its work is up to the workspace. The plan and the
fan-out orchestrator in the `agent` workspace decide which rows to send, what
the note beside a row says, how a blocker reads and when a finished row can
go. eleven used to make some of those calls, so changing them meant changing
eleven.

Producers describe panels with a small display vocabulary, and each channel
decides how to draw it. A producer never needs to know which channel is
listening, and a new channel works with the producers that already exist.

We considered letting each extension render for each channel and rejected it.
Every extension would have to know every channel, and adding a channel would
break all of them.

## The vocabulary

```ts
interface Panel {
  title: string;
  icon?: string;   // a glyph a channel may put before the title
  rows: Row[];
  more?: number;   // rows you left out
  quiet?: boolean; // carried over from an earlier turn
}

interface Row {
  text: string;
  state: "idle" | "waiting" | "active" | "done" | "failed" | "stopped";
  note?: string;               // one line beside the text
  detail?: [string, string][]; // label/value pairs a channel may open on demand
}
```

A channel turns `state` into an icon. The producer formats everything else in
`text`, `note` and `detail`.

A report is the full list of panels a producer currently shows. It replaces
that producer's previous report and leaves every other producer's alone. An
empty list clears it.

### Scope

The scope is what keeps producers apart. Without it, the first producer to
report would wipe everyone else's panels off the card. A tool call uses its
call id as its scope. An extension that reports outside a tool picks its own.

### What eleven still decides

- A panel with no rows and no `more` count isn't drawn.
- Each channel caps how many rows it draws. Telegram hides finished rows first,
  oldest first, and counts them on one line.
- A `quiet` panel is drawn, but it never makes Telegram post a status message.
  Use it for work carried over from an earlier turn, so a thread with an open
  plan doesn't get a new card on every message.
- When a turn is stopped or fails, every `active` row is shown as `stopped`.
  Nothing is working on it anymore, and the producer may be the thing that
  died, so it can't be trusted to do this itself.
- When a tool publishes panels, the status line stops showing a preview of its
  arguments, since the rows already describe the work.

## Publishing from a tool

The fourth argument of a tool's `execute` is an update callback. Put the panels
in `details.panels`:

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  onUpdate?.({
    content: [{ type: "text", text: "working" }],
    details: { panels: [{ title: "Phases", rows: [{ text: "Scouting", state: "active" }] }] },
  });
  // …
}
```

This works with every provider, including Claude Code, where the tool runs
behind the MCP bridge. A panel without a title gets the tool's name.

## Publishing outside a tool

A pi extension has no update callback outside `execute`, so it can't draw
anything on `turn_start`, for example. eleven exposes a handshake for that:

```ts
interface ElevenHost {
  version: 2;
  panels(panels: unknown, options?: { scope?: string }): boolean;
}

globalThis.eleven?.panels(panels, { scope: "tasks" });
```

The panels go to the conversation whose turn is on the call stack. The call
returns `false` when no turn is listening, which is always the case under
plain pi, so the same extension file runs with or without eleven.

The handshake lives on `globalThis` because pi loads workspace extensions
itself, and a file in a workspace directory has no import path back to the
eleven hosting it. Check `version` before calling.

It gives an extension no new permissions. The extension already runs
in-process with whatever tools the workspace granted. eleven validates its
panels the same way it validates a tool's and drops anything malformed, so
publishing a panel can't make the publisher fail.

## Delegation is not a capability

eleven never grants Claude Code's `Agent`, `SendMessage` or its own
`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` to a workspace, so the runtime
never brings a second plan or a second way to fan out.

A native subagent runs as a session eleven doesn't own. Extension tools are
bridged into it, but it gets its own session id. An extension that keeps state
per conversation would fork that state without noticing and report the fork
under the parent's scope, replacing the parent's panels. The capability list
has no way to say that two sessions are the same conversation. A workspace
that wants fan-out should ship it as an extension tool, which has one identity
and reports from one place.

To withhold any other native tool, for example because the workspace ships its
own version, list it in `excludeNativeTools`:

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

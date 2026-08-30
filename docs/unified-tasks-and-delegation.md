# Study: unifying plans, delegation and progress across providers

Status: **implemented** (2026-08-30). Kept as the rationale for the change;
the two open questions it named were measured before acting, results below.
Date: 2026-08-30

## The complaint, restated

Three capabilities that are conceptually one thing are implemented three
different ways, and only one of them works on one provider:

| capability | pi providers | claude-code provider | owner | how it reaches the user |
|---|---|---|---|---|
| plan / task list | **absent** | native `TaskCreate/Get/List/Update` | Claude CLI, in-memory | scraped by eleven → `TaskActivityEvent` → Telegram |
| subagent delegation | **absent** | native `Task` / `Agent` | Claude CLI | scraped from SDK `system` messages |
| fan-out orchestration | `workflow` | `workflow` (children are CC subprocesses) | **workspace extension**, not eleven | nothing — one `🔧 workflow` line |

Adding a presentation for `workflow` inside eleven would mean eleven learning
what a workspace extension is. That is the coupling we want to avoid.

## Root cause

`TaskActivityEvent` (`src/agent/task-activity.ts`) is *provider-neutral by
shape* but has exactly **one producer**: the Claude Code scraper.

- `applyPlanToolResults` (`src/agent/claude-code.ts:961`) mirrors Claude's task
  store by parsing `tool_result` payloads — ~65 lines of reverse-engineering a
  store we do not own.
- `emitAgentTaskActivity` (`src/agent/claude-code.ts:1037`) does the same for
  the native subagent roster.
- The mirror lives in `planTasksBySession`, a process-memory `Map`
  (`src/agent/claude-code.ts:198`) that dies with the daemon.

Nothing else in the system can report progress. A pi tool, an extension tool,
a channel tool — all of them can only speak by *returning a final result*.

Meanwhile the channel for it already exists and is unused:

- pi defines `execute(toolCallId, params, signal, onUpdate, ctx)` and emits
  `tool_execution_update { toolCallId, toolName, args, partialResult }`
  (`pi-agent-core/dist/types.d.ts:349,402`). The runner subscribes to
  `tool_execution_start` only (`src/agent/runner.ts:498`).
- The MCP bridge explicitly passes `undefined` as the update callback
  (`src/agent/claude-code.ts:771`).

## Layer 0 — an activity sink on tool execution (the enabling change)

Make the fourth argument of `execute` a real channel, and define the payload as
**data**, not as a per-tool integration:

```ts
// task-activity.ts
export interface ToolActivityDetails {
  activity?: TaskActivityEvent[];
}
```

- **pi path** — `session.subscribe` handles `tool_execution_update`; if
  `partialResult.details.activity` exists, forward each event to
  `events.onTaskActivity`.
- **MCP path** — `buildMcpServer` passes a real `onUpdate` that forwards to
  `registration.onTaskActivity`. (Better than the pi path: eleven owns the
  callback directly.)

Consequences:

- Any tool — the `workflow` extension today, a `deep-research` tool tomorrow, a
  workspace's own tool — reports plan rows and agent rows in the **same
  vocabulary the Claude natives already produce**, and `renderTaskActivity`
  renders them unchanged. Eleven learns nothing about any specific tool.
- Ids must be namespaced by the emitter (`<toolCallId>:<n>`) so a tool's rows
  cannot collide with Claude's task ids inside the same turn.
- The dashboard receives `onToolCall` but not task activity — only the Telegram
  channel subscribes. Wired at the same time: the gateway folds the events into
  a board (`TaskActivityBoard`) and broadcasts *the whole board*, which is also
  what the catch-up endpoint serves — so a page that connects mid-turn and one
  that watched from the start agree without the client replaying anything.
  Subagent rows are clickable, showing what the runtime reported for that agent
  (type, last tool, tokens, tool calls, duration, summary). There is no
  per-agent provider request to link to: a nested runtime drives its own tool
  loop, so those calls never reach eleven's request log, and the panel says so.

Cost: ~15 lines in eleven, ~30 in the workflow extension — the engine already
tracks phases, labels, agent count and token usage (`engine.ts`), it just
discards them until the run ends.

**This is the change to make first, independently of everything below.**

## Layer 1 — eleven owns the task list

Move `TaskCreate/TaskGet/TaskList/TaskUpdate` out of `POLICY_TO_NATIVE`
(`src/agent/claude-code.ts:45`) and implement them as eleven custom tools —
same mechanism as the Telegram tool — backed by a per-thread store.

Wins:

- Works on **every** provider. A pi session gets a plan list for the first
  time; a failover from `claude-code/opus` to a pi model stops silently
  changing the agent's capabilities mid-conversation.
- Deletes the scraper and the memory mirror: the tool call **is** the event.
- Can be persisted in the thread directory, so a plan survives a daemon
  restart. Today it does not.
- One store the workflow engine can also write to — a fan-out's phases become
  rows in the same plan the model is already reading.

Costs, honestly:

- ~150 lines of CRUD plus the `blocks`/`blockedBy` graph, reimplemented.
- We lose the CLI's own nudges (the "task tools haven't been used recently"
  reminder is injected by Claude Code, not by us).
- **Open question that needs a spike before committing:** do Claude Code's
  native subagents see MCP tools registered with `alwaysLoad: true`? Today the
  native task store is shared with subagents by construction. If MCP tools do
  not propagate, an eleven-owned task list would be invisible to native
  subagents — which matters only if we keep them (see Layer 2).

## Layer 2 — one delegation surface

Today a claude-code session exposes **two** delegation mechanisms at once:
native `Task`/`Agent`, and `mcp__eleven__workflow`. Same job, different
contracts, different progress, and both ship their own "don't use me unless
asked" restraint text.

**Recommendation: drop `Task`/`Agent` from `POLICY_TO_NATIVE.agent` and keep
`workflow` as the only delegation tool.**

- It is the only one that works on both providers.
- It is scriptable and inspectable — the script *is* the plan. The native Agent
  tool is a black box whose model choice we do not control (`tier`/`effort`
  versus `subagent_type`).
- We already have to neuter the native one: `foregroundToolInput`
  (`src/agent/claude-code.ts:922`) strips `run_in_background` and `isolation`
  because a pi turn cannot outlive its provider stream. We are paying for a
  feature we must disable.

What we would lose: Claude's subagent implementation is genuinely better
instrumented — it emits `task_started`/`task_progress`/`task_notification` with
last tool name, summary and usage, all of which eleven already renders. The
workflow engine's subagents are pi `AgentSession`s with read-only tools and no
progress summaries at all. **So Layer 0 must land first**, or this trades a
well-instrumented black box for an uninstrumented one.

Rejected alternative — *keep both, split their jobs by contract* ("native Agent
for one delegated sub-investigation, workflow for N>3 fan-out"). That is the
status quo with better prompting, and it does nothing for pi providers.

Rejected alternative — *move the workflow engine into eleven*. It would be
provider-neutral by construction and would need no activity envelope. But the
extension boundary is correct: authoring policy belongs to the workspace, and
`.pi/extensions` is the sanctioned injection point. The extension does not need
to move; it needs an output channel, which is Layer 0.

## Unmeasured risk to settle before Layer 2

Every `agent()` call inside a workflow running on a claude-code session takes
the *isolated* path (`src/agent/claude-code.ts:434,540`) and spawns a **Claude
Code CLI child process** with read-only tools, `persistSession: false`, and its
transcript deleted afterwards. The engine caps concurrency at 16 and 1000
agents per run (`engine.ts:15`).

Nobody has measured 16 concurrent CLI children. Before making `workflow` the
only delegation surface we would be replacing Claude's in-process subagents
with a subprocess-per-agent design at 16× concurrency. Measure it first.

Related observation: `markTool` fires `registration.onToolCall` even for
isolated sessions (`src/agent/claude-code.ts:525`), so workflow subagents' tool
calls already land in the Pi transcript and the dashboard — as an
**unattributed flood** of `Read`/`Grep` from anonymous children. Layer 0 would
give those rows an owner.

## Naming

Claude Code ships its own product tool called `Workflow`, deliberately excluded
from eleven's allowlist (`src/agent/claude-code.ts:57`). Our `workflow` means
something else. If Layer 2 happens, rename ours to avoid the collision.

## Results of the two blocking questions

**Do MCP tools reach Claude native subagents?** Yes. A spawned `general-purpose`
subagent listed its tools as `Agent, Glob, Grep, Read, mcp__spike__spike_probe`
and called the probe. SDK-MCP tools registered with `alwaysLoad` are carried
into a subagent's tool set — so an eleven-owned plan is visible to them, and
Layer 1 was safe to build.

**What does a fan-out cost on claude-code?** Measured with concurrent isolated
queries, the exact shape each `agent()` call takes:

| concurrent agents | descendant processes | peak resident | wall clock |
|---|---|---|---|
| 4 | 5 | 1.2 GB | 2.3 s |
| 16 | 39 | 4.8 GB | 4.1 s |

All 16 succeeded, so this is a cost, not a failure — but ~300 MB and ~2.4
processes per agent is a third of a 16 GB machine for one tool call. (Summed
RSS overcounts pages shared between the children, so treat it as an upper
bound; the process count is exact.) Layer 2 therefore shipped with the fan-out
halved to 8 when the session model is `claude-code/*`.

## Order of work

1. **Layer 0** — activity sink. Cheap, general, unblocks everything, couples
   nothing.
2. **Layer 1** — eleven-owned task list, after the subagent/MCP propagation
   spike.
3. **Measure** workflow-under-claude-code subprocess cost.
4. **Layer 2** — collapse to one delegation surface, only if 1 and 3 are green.

import { deepStrictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { activeToolNames, elevenOwnedTools } from "../src/agent/tool-policy.ts";
import { nativeToolsForPolicy } from "../src/agent/claude-code.ts";
import { BUILTIN_TOOLS, type WorkspaceTool } from "../src/config.ts";

// pi registers all eight of its builtins but only activates its coding default.
// The other four exist for pi's read-only preset (grep/find/ls, for a session
// with no bash) and for Windows (powershell).
const PI_REGISTERED = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const PI_ACTIVE = ["read", "bash", "edit", "write"];
const EXTENSION_TOOLS = ["workflow"];
const CHANNEL_TOOLS = ["telegram"];

describe("elevenOwnedTools", () => {
  test("is the extension and channel tools, never the pi registry", () => {
    const owned = elevenOwnedTools(EXTENSION_TOOLS, CHANNEL_TOOLS);
    deepStrictEqual(owned, ["workflow", "telegram"]);
    deepStrictEqual(owned.filter((name) => PI_REGISTERED.includes(name)), []);
  });

  test("dedupes a tool a workspace extension and a channel both name", () => {
    deepStrictEqual(elevenOwnedTools(["telegram"], ["telegram"]), ["telegram"]);
  });
});

describe("activeToolNames", () => {
  const owned = elevenOwnedTools(EXTENSION_TOOLS, CHANNEL_TOOLS);
  const piActiveWithOwned = [...PI_ACTIVE, ...owned];

  test("without a policy, keeps exactly what pi activated plus eleven's own", () => {
    deepStrictEqual(
      activeToolNames(piActiveWithOwned, owned, undefined),
      ["read", "bash", "edit", "write", "workflow", "telegram"],
    );
  });

  test("never activates a pi builtin pi left inactive", () => {
    // Regression: the active set used to be seeded from session.getAllTools(),
    // so powershell/grep/find/ls were treated as eleven-owned and switched on —
    // 2.8KB of schema per request, a PowerShell tool on Linux, and a second
    // shell that survived revoking `bash`.
    const active = activeToolNames(piActiveWithOwned, owned, undefined);
    deepStrictEqual(active.filter((name) => ["powershell", "grep", "find", "ls"].includes(name)), []);
  });

  test("revoking bash takes powershell with it", () => {
    // A workspace that says no shell must not get one through the back door.
    deepStrictEqual(
      activeToolNames([...PI_ACTIVE, "powershell", ...owned], owned, ["read", "edit", "write"]),
      ["read", "edit", "write", "workflow", "telegram"],
    );
  });

  test("grep/find/ls answer to the read capability", () => {
    // pi's read-only preset: read plus the tools that stand in for bash.
    deepStrictEqual(
      activeToolNames(["read", "grep", "find", "ls", ...owned], owned, ["read"]),
      ["read", "grep", "find", "ls", "workflow", "telegram"],
    );
    deepStrictEqual(
      activeToolNames(["read", "grep", "find", "ls", ...owned], owned, ["bash"]),
      ["workflow", "telegram"],
    );
  });

  test("web and agent gate nothing on pi, and never revoke eleven's tools", () => {
    deepStrictEqual(activeToolNames(piActiveWithOwned, owned, ["web", "agent"]), ["workflow", "telegram"]);
  });
});

describe("nativeToolsForPolicy (Claude Code side)", () => {
  test("never offers a tool that only addresses background tasks", () => {
    // Regression: TaskOutput and TaskStop shipped in every request, but
    // foregroundToolInput strips run_in_background from every Agent and Bash
    // call, so neither ever had a task to read or stop.
    const background = ["TaskOutput", "TaskStop"];
    for (const policy of [undefined, ["agent"] as WorkspaceTool[], [...BUILTIN_TOOLS]]) {
      deepStrictEqual(nativeToolsForPolicy(policy).filter((name) => background.includes(name)), []);
    }
  });

  test("the unrestricted default is exactly the full policy expansion", () => {
    // The two used to be hand-maintained lists and drifted; keep them derived.
    deepStrictEqual(nativeToolsForPolicy(undefined), nativeToolsForPolicy([...BUILTIN_TOOLS]));
  });

  test("offers no native plan or delegation tools at all", () => {
    // Both jobs are eleven's now and work on every provider: the plan is
    // task-tools.ts, delegation is the `workflow` tool. A native second surface
    // for either means two stores (or two ways to spawn), on one provider only,
    // with the model picking between them.
    const superseded = ["Task", "Agent", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];
    for (const policy of [undefined, ["agent"] as WorkspaceTool[], [...BUILTIN_TOOLS]]) {
      deepStrictEqual(nativeToolsForPolicy(policy).filter((name) => superseded.includes(name)), []);
    }
  });

  test("the agent capability now gates only eleven's own tools", () => {
    deepStrictEqual(nativeToolsForPolicy(["agent"]), []);
  });
});

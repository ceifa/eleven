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

  test("carries the agent capability's own tools again", () => {
    // A stock eleven has to ship a plan and a way to delegate. Layer 2 dropped
    // them on the assumption that a workspace extension supplies both — true
    // here, false for anyone else running eleven.
    deepStrictEqual(
      nativeToolsForPolicy(["agent"]),
      ["Task", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"],
    );
  });

  test("a workspace can withhold natives it supplies itself", () => {
    // The opt-out that replaces the hardcoded removal: by name, per workspace.
    const withheld = ["Task", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];
    deepStrictEqual(nativeToolsForPolicy(["agent"], withheld), []);
    deepStrictEqual(nativeToolsForPolicy(["read", "agent"], withheld), ["Read", "Glob", "Grep"]);
    // Withholding one leaves the rest alone.
    deepStrictEqual(nativeToolsForPolicy(["agent"], ["Task"]), ["SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
    // And it narrows the unrestricted default too, not just an explicit policy.
    deepStrictEqual(nativeToolsForPolicy(undefined, ["Task"]).includes("Task"), false);
  });
});

import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { summarizeToolArgs } from "../src/util.ts";

test("a labeled shell command shows its label and the command", () => {
  strictEqual(
    summarizeToolArgs({ command: "git status --short", description: "Show working tree status" }),
    "Show working tree status · git status --short",
  );
});

test("an unlabeled command shows the command alone", () => {
  strictEqual(summarizeToolArgs({ command: "git status --short" }), "git status --short");
  strictEqual(summarizeToolArgs({ command: "git status --short", description: " " }), "git status --short");
});

test("a description without a command is not promoted over the leading field", () => {
  strictEqual(summarizeToolArgs({ subject: "Fix login", description: "Long task body" }), "Fix login");
});

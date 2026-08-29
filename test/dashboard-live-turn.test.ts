import assert from "node:assert/strict";
import test from "node:test";
import { elapsed, liveStatus, shownLive, transcriptRows } from "../src/dashboard/public/live-turn.js";

/* The bug these exist for: a message sent while a turn was running rendered
   above everything that turn had streamed. The transcript region sits above the
   live region, and a steered message is persisted the moment it lands — so the
   durable record put it at the top of a turn it actually arrived in the middle
   of. The fix is for the live turn to own such a message, and for the durable
   transcript to stand down where it does. */

const turnStart = 1_000_000;
const steered = { role: "user" as const, text: "wait, also check the logs" };

test("a message the running turn is showing is not drawn again by the transcript", () => {
  const live = [
    { kind: "tool", id: "a", name: "Read" },
    { kind: "message", role: "user", text: steered.text, at: turnStart + 5_000 },
    { kind: "text", text: "sure — looking" },
  ];
  const durable = { kind: "message", ...steered };
  assert.equal(shownLive(live, durable, turnStart + 5_000, turnStart), true);
});

test("without a running turn the transcript draws everything itself", () => {
  const live = [{ kind: "message", role: "user", text: steered.text, at: turnStart }];
  // startedAt 0 means no turn is live: nothing on screen can be claimed by one.
  assert.equal(shownLive(live, { kind: "message", ...steered }, turnStart, 0), false);
});

test("an older message repeating the same words still renders", () => {
  const live = [{ kind: "message", role: "user", text: "ok", at: turnStart + 1_000 }];
  const earlier = { kind: "message", role: "user" as const, text: "ok" };
  assert.equal(shownLive(live, earlier, turnStart - 90_000, turnStart), false);
  assert.equal(shownLive(live, earlier, turnStart + 1_000, turnStart), true);
});

test("only messages are ever claimed by the live turn", () => {
  const live = [{ kind: "message", role: "user", text: steered.text, at: turnStart }];
  const calls = { kind: "tool-calls", calls: [{ id: "a", name: "Read", summary: "" }] };
  assert.equal(shownLive(live, calls, turnStart + 10, turnStart), false);
});

/* The other half of "is it alive?": a line that says what the turn is doing. */

test("a turn that has produced nothing is thinking", () => {
  assert.equal(liveStatus([], { now: 5_000, lastDeltaAt: 0 }), "Thinking…");
});

test("the last tool call is what the turn is busy with", () => {
  const live = [{ kind: "text", text: "let me look" }, { kind: "tool", id: "a", name: "Bash" }];
  assert.equal(liveStatus(live, { now: 5_000, lastDeltaAt: 4_900 }), "Using Bash…");
});

test("prose that is still arriving reads as writing, prose that stopped does not", () => {
  const live = [{ kind: "text", text: "here is what I found" }];
  assert.equal(liveStatus(live, { now: 5_000, lastDeltaAt: 4_800 }), "Writing…");
  assert.equal(liveStatus(live, { now: 60_000, lastDeltaAt: 4_800 }), "Thinking…");
});

test("a message steered into the turn leaves it thinking, not writing", () => {
  const live = [{ kind: "message", role: "user", text: steered.text, at: 4_900 }];
  assert.equal(liveStatus(live, { now: 5_000, lastDeltaAt: 4_900 }), "Thinking…");
});

/* The ⚡ view's bug: every provider-request chip of a turn arrived in one clump
   after that turn's tool calls, instead of sitting between the calls it paid
   for. The calls had been merged into one block by the reader, which put the
   whole run on the first call's clock — so nothing could sort into it. */

const iso = (ms: number) => new Date(ms).toISOString();

/** A turn that called three tools, with a provider request before each. */
function loopingTurn() {
  const t = Date.parse("2026-08-29T12:00:00.000Z");
  return {
    timeline: [
      { kind: "message", role: "user", text: "ship it", timestamp: iso(t) },
      { kind: "tool-calls", calls: [{ id: "c1", name: "Read", summary: "" }], timestamp: iso(t + 2_000) },
      { kind: "tool-calls", calls: [{ id: "c2", name: "Bash", summary: "" }], timestamp: iso(t + 4_000) },
      { kind: "tool-calls", calls: [{ id: "c3", name: "Edit", summary: "" }], timestamp: iso(t + 6_000) },
      { kind: "message", role: "assistant", text: "shipped", timestamp: iso(t + 8_000) },
    ],
    requests: [
      { id: "r1", model: "opus", at: t + 1_000, bytes: 10 },
      { id: "r2", model: "opus", at: t + 3_000, bytes: 10 },
      { id: "r3", model: "opus", at: t + 5_000, bytes: 10 },
    ],
  };
}

test("provider requests sit between the calls they paid for, not in a clump", () => {
  const { timeline, requests } = loopingTurn();
  const rows = transcriptRows({ timeline, requests, showRequests: true });
  assert.deepEqual(rows.map((row) => row.kind), [
    "day", "message", "request", "tool-calls", "request", "tool-calls", "request", "tool-calls", "message",
  ]);
  // Each block is exactly the one call it stands for — nothing was merged
  // across a chip that sorted between two of them.
  assert.deepEqual(
    rows.filter((row) => row.kind === "tool-calls").map((row) => row.calls.map((call) => call.name)),
    [["Read"], ["Bash"], ["Edit"]],
  );
});

test("with the chips hidden, consecutive calls still read as one block", () => {
  const { timeline, requests } = loopingTurn();
  const rows = transcriptRows({ timeline, requests, showRequests: false });
  assert.deepEqual(rows.map((row) => row.kind), ["day", "message", "tool-calls", "message"]);
  assert.deepEqual(rows[2].calls.map((call) => call.name), ["Read", "Bash", "Edit"]);
});

test("a message steered into a turn breaks the run of calls around it", () => {
  const t = Date.parse("2026-08-29T12:00:00.000Z");
  const rows = transcriptRows({
    timeline: [
      { kind: "tool-calls", calls: [{ id: "c1", name: "Read", summary: "" }], timestamp: iso(t) },
      { kind: "message", role: "user", text: "also the logs", timestamp: iso(t + 1_000) },
      { kind: "tool-calls", calls: [{ id: "c2", name: "Bash", summary: "" }], timestamp: iso(t + 2_000) },
    ],
  });
  assert.deepEqual(rows.map((row) => row.kind), ["day", "tool-calls", "message", "tool-calls"]);
});

test("what the running turn is already showing is left out of the transcript", () => {
  const t = Date.parse("2026-08-29T12:00:00.000Z");
  const live = [
    { kind: "tool", id: "c1", name: "Read" },
    { kind: "message", role: "user", text: "also the logs", at: t + 1_000 },
  ];
  const rows = transcriptRows({
    timeline: [
      { kind: "tool-calls", calls: [{ id: "c1", name: "Read", summary: "" }], timestamp: iso(t) },
      { kind: "message", role: "user", text: "also the logs", timestamp: iso(t + 1_000) },
      { kind: "tool-calls", calls: [{ id: "c2", name: "Bash", summary: "" }], timestamp: iso(t + 2_000) },
    ],
    live,
    liveStartedAt: t - 1_000,
  });
  // The call and the steered message are the live region's; only the call it
  // has not drawn yet is left for the transcript.
  assert.deepEqual(rows.map((row) => row.kind), ["day", "tool-calls"]);
  assert.deepEqual(rows[1].calls.map((call) => call.name), ["Bash"]);
});

test("consecutive messages from one speaker group, and anything between them breaks it", () => {
  const t = Date.parse("2026-08-29T12:00:00.000Z");
  const rows = transcriptRows({
    timeline: [
      { kind: "message", role: "user", text: "one", timestamp: iso(t) },
      { kind: "message", role: "user", text: "two", timestamp: iso(t + 1_000) },
      { kind: "tool-calls", calls: [{ id: "c1", name: "Read", summary: "" }], timestamp: iso(t + 2_000) },
      { kind: "message", role: "user", text: "three", timestamp: iso(t + 3_000) },
      // Far enough later that it opens its own block, however quiet the room was.
      { kind: "message", role: "user", text: "four", timestamp: iso(t + 600_000) },
    ],
  });
  assert.deepEqual(rows.filter((row) => row.kind === "message").map((row) => row.grouped), [false, true, false, false]);
});

test("the clock is m:ss from the turn's own start", () => {
  assert.equal(elapsed(0, 0), "0:00");
  assert.equal(elapsed(0, 9_400), "0:09");
  assert.equal(elapsed(0, 83_000), "1:23");
  assert.equal(elapsed(0, 3_723_000), "62:03");
  // A clock that has run backwards (a corrected system time) says zero, not "-1:59".
  assert.equal(elapsed(10_000, 0), "0:00");
});

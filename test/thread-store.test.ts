import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadStore } from "../src/threads/store.ts";

const DAY = 24 * 60 * 60 * 1000;

function store(): { store: ThreadStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "eleven-threads-"));
  return { store: new ThreadStore(join(dir, "threads.json")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("prune drops threads past retention that no conversation points at", () => {
  const { store: threads, cleanup } = store();
  try {
    const stale = threads.rotate("telegram:main:1", "agent");
    const fresh = threads.rotate("telegram:main:1", "agent"); // pushes `stale` out of current
    threads.update(stale.id, { lastActivityAt: Date.now() - 40 * DAY });

    const dropped = threads.prune(30 * DAY, 7 * DAY);
    assert.deepEqual(dropped.map((t) => t.id), [stale.id]);
    assert.equal(threads.get(fresh.id)?.id, fresh.id);
  } finally {
    cleanup();
  }
});

test("prune drops a current thread that is past retention and can no longer be resumed", () => {
  const { store: threads, cleanup } = store();
  try {
    // Regression: being `current` used to protect a thread forever, so a
    // conversation silent for months kept its transcript past retention.
    const abandoned = threads.rotate("telegram:main:1", "agent");
    threads.update(abandoned.id, { lastActivityAt: Date.now() - 43 * DAY });

    const dropped = threads.prune(30 * DAY, 7 * DAY);
    assert.deepEqual(dropped.map((t) => t.id), [abandoned.id]);
    assert.equal(threads.get(abandoned.id), undefined);
    // Unpinned, so the next message mints a fresh thread instead of a dangling id.
    assert.equal(threads.current("telegram:main:1"), undefined);
    const next = threads.resolve("telegram:main:1", "agent", 7 * DAY);
    assert.notEqual(next.id, abandoned.id);
  } finally {
    cleanup();
  }
});

test("prune keeps a current thread that is still inside the idle window", () => {
  const { store: threads, cleanup } = store();
  try {
    // retention shorter than idle: the thread is old but the next message would
    // still continue it, so it must survive.
    const resumable = threads.rotate("telegram:main:1", "agent");
    threads.update(resumable.id, { lastActivityAt: Date.now() - 40 * DAY });

    assert.deepEqual(threads.prune(30 * DAY, 60 * DAY), []);
    assert.equal(threads.current("telegram:main:1")?.id, resumable.id);
  } finally {
    cleanup();
  }
});

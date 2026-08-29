import assert from "node:assert/strict";
import test from "node:test";
import { syncChildren } from "../src/dashboard/public/dom.js";

/** The four operations syncChildren performs, counted. Enough of a DOM to run
 *  the algorithm and to see what it costs — which is the whole point: a wrong
 *  reconciler still ends up with the right children, just after touching all of
 *  them. */
class Node {
  readonly name: string;
  parent: Container | undefined;

  constructor(name: string) {
    this.name = name;
  }

  get nextSibling(): Node | undefined {
    const siblings = this.parent?.children;
    if (!siblings) return undefined;
    return siblings[siblings.indexOf(this) + 1];
  }

  remove() {
    if (!this.parent) return;
    this.parent.removals++;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
}

class Container {
  children: Node[] = [];
  /** insertBefore calls that moved a node already in this container. */
  moves = 0;
  /** insertBefore calls that brought in a node from outside. */
  inserts = 0;
  removals = 0;

  get firstChild(): Node | undefined {
    return this.children[0];
  }

  insertBefore(node: Node, reference: Node | undefined) {
    const held = this.children.indexOf(node);
    if (held >= 0) {
      this.children.splice(held, 1);
      this.moves++;
    } else {
      this.inserts++;
    }
    node.parent = this;
    const at = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
  }

  get names() {
    return this.children.map((child) => child.name);
  }

  get touched() {
    return this.moves + this.inserts + this.removals;
  }
}

/** A container holding `count` rows, plus the rows themselves by name. */
function seeded(count: number) {
  const container = new Container();
  const rows = new Map<string, Node>();
  for (let i = 0; i < count; i++) {
    const node = new Node(`r${i}`);
    rows.set(node.name, node);
    container.insertBefore(node, undefined);
  }
  container.moves = 0;
  container.inserts = 0;
  container.removals = 0;
  return { container, rows, pick: (...names: string[]) => names.map((name) => rows.get(name)!) };
}

test("an unchanged list is not touched at all", () => {
  const { container, pick } = seeded(200);
  const same = pick(...Array.from({ length: 200 }, (_, i) => `r${i}`));
  syncChildren(container as never, same as never);
  assert.equal(container.touched, 0);
  assert.equal(container.names[0], "r0");
});

test("a row moving to the front costs one move, not a rebuilt list", () => {
  const { container, pick } = seeded(200);
  const order = ["r150", ...Array.from({ length: 200 }, (_, i) => `r${i}`).filter((n) => n !== "r150")];
  syncChildren(container as never, pick(...order));
  assert.deepEqual(container.names, order);
  assert.equal(container.moves, 1);
  assert.equal(container.touched, 1);
});

// The regression this file exists for: a stale row left in the cursor's way
// made every row after it get inserted around it — correct output, a hundred
// times the DOM work.
test("a row leaving the middle costs one removal, and moves nothing", () => {
  const { container, pick } = seeded(200);
  const order = Array.from({ length: 200 }, (_, i) => `r${i}`).filter((n) => n !== "r5");
  syncChildren(container as never, pick(...order));
  assert.deepEqual(container.names, order);
  assert.equal(container.removals, 1);
  assert.equal(container.moves, 0);
  assert.equal(container.inserts, 0);
});

test("a new row and a departed one, together, cost one of each", () => {
  const { container, rows, pick } = seeded(200);
  const fresh = new Node("fresh");
  rows.set(fresh.name, fresh);
  const order = ["fresh", ...Array.from({ length: 200 }, (_, i) => `r${i}`).filter((n) => n !== "r80")];
  syncChildren(container as never, pick(...order));
  assert.deepEqual(container.names, order);
  assert.equal(container.inserts, 1);
  assert.equal(container.removals, 1);
  assert.equal(container.moves, 0);
});

test("a list emptied and refilled ends up with exactly what was asked for", () => {
  const { container, rows, pick } = seeded(10);
  syncChildren(container as never, []);
  assert.deepEqual(container.names, []);
  assert.equal(container.removals, 10);

  for (const name of ["x", "y"]) rows.set(name, new Node(name));
  syncChildren(container as never, pick("x", "r3", "y"));
  assert.deepEqual(container.names, ["x", "r3", "y"]);
});

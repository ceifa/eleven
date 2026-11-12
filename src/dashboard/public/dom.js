/* DOM primitives the dashboard renders through. Kept apart from app.js so the
   ones with an algorithm in them can be tested outside a browser. */

/**
 * Put `nodes` in `container`, in this order, moving what is already there
 * instead of replacing it. Nodes carry their own listeners, classes and
 * running animations, so reusing one costs nothing a rebuild wouldn't have
 * thrown away — and a list of hundreds of rows changes by two of them.
 *
 * The walk is a single pass with a cursor. The subtlety is the `dropStale`
 * call: a row that no longer belongs has to leave the moment the cursor
 * reaches it. Leave it there and the cursor parks on a node no desired row
 * will ever equal, and every row after it gets inserted around the corpse —
 * one deletion silently turning into a hundred DOM moves.
 */
export function syncChildren(container, nodes) {
  const wanted = new Set(nodes);
  let cursor = container.firstChild;
  const dropStale = () => {
    while (cursor && !wanted.has(cursor)) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  };
  for (const node of nodes) {
    dropStale();
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    container.insertBefore(node, cursor); // already in the DOM? this moves it
  }
  dropStale();
}

/**
 * Make `container` hold what `nodes` describe, leaving alone every child at its
 * head that already reads the same.
 *
 * This is for content that grows at its end and is drawn again whole each time
 * it does — a reply being streamed, parsed from the top on every delta. The
 * parse is cheap; what is not is handing the page three hundred new elements to
 * style, lay out and paint, dozens of times a second, when all but the last
 * paragraph are the elements it already has. `isEqualNode` is the browser's own
 * deep comparison, so "reads the same" means exactly that: a change anywhere in
 * a block — an earlier list turned loose by a blank line, a reference link
 * resolved by a definition that just arrived — replaces from that block on.
 */
export function replaceTail(container, nodes) {
  let index = 0;
  let child = container.firstChild;
  while (child && index < nodes.length && child.isEqualNode(nodes[index])) {
    child = child.nextSibling;
    index++;
  }
  while (child) {
    const next = child.nextSibling;
    child.remove();
    child = next;
  }
  for (; index < nodes.length; index++) container.insertBefore(nodes[index], null);
}

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

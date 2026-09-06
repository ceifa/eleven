/* The mobile drawer's swipe, kept apart from app.js because it is a state
   machine over a stream of touches and the only way to be sure it still tells a
   scroll from a drag is to run it outside a browser. It decides nothing about
   the DOM: it is handed geometry and gives back where the drawer should be. */

/**
 * How far in from the left edge a touch can start and still mean "pull the
 * drawer out".
 *
 * A fifth of the screen rather than a hairline at the very edge: the outermost
 * few millimetres belong to the phone — iOS and Android both read a swipe there
 * as "go back" — so a zone that lived only there would be a gesture the OS wins
 * first, and the drawer would open on some phones and not others.
 */
export const edgeZone = (screen) => Math.max(32, screen * 0.2);

/** Travel before the gesture commits to an axis. Under this nobody knows yet
 *  whether the finger is pulling the drawer or scrolling the page. */
export const AXIS_SLOP = 8;

/** A flick: released still moving faster than this (px/ms), the direction
 *  decides on its own, however far the finger actually got. A deliberate drag
 *  runs around 0.5; a throw is well past 1. */
export const FLICK_SPEED = 1;

/** How much of the recent past the release speed is measured over. One frame
 *  is far too jittery a sample to decide a gesture on, and a finger that drags
 *  the drawer and stops before letting go spends its last frames going
 *  nowhere — which is exactly the "not a flick" this has to see. */
export const VELOCITY_WINDOW = 100;

/**
 * One drawer gesture at a time.
 *
 * `start` says whether this touch is worth watching, `move` returns the
 * drawer's position once the gesture has committed to being one (and null while
 * it is still ambiguous, or never was), and `end` says where it should settle.
 * A tap, a scroll and a swipe the wrong way all end as null, which is what
 * keeps every other touch on the page working.
 */
export function navDrag({ slop = AXIS_SLOP, flick = FLICK_SPEED, window = VELOCITY_WINDOW } = {}) {
  let phase = "idle";
  let startX = 0;
  let startY = 0;
  let width = 1;
  /** Where the drawer was when the finger landed — which way it can travel. */
  let wasOpen = false;
  let progress = 0;
  /** The last `window` milliseconds of the finger, oldest first. */
  let trail = [];

  const cancel = () => {
    phase = "idle";
  };

  return {
    get dragging() {
      return phase === "drag";
    },
    /** A finger landed. Returns whether it could still become a drawer drag. */
    start({ x, y, at, open, drawer, screen }) {
      cancel();
      if (!(drawer > 0)) return false;
      // Closed, the drawer is off-screen: only a touch near the edge it hides
      // behind can be reaching for it. Open, it is under the finger already.
      if (!open && x > edgeZone(screen)) return false;
      phase = "watch";
      wasOpen = open;
      width = drawer;
      startX = x;
      startY = y;
      progress = open ? 1 : 0;
      trail = [{ x, at }];
      return true;
    },
    /** The finger moved. Returns the drawer's position, or null while the
     *  gesture is still ambiguous — or once it has been ruled out. */
    move({ x, y, at }) {
      if (phase === "idle") return null;
      const dx = x - startX;
      const dy = y - startY;
      if (phase === "watch") {
        // Vertical intent this early is a scroll, and a drawer that took it
        // over would make the page underneath feel stuck.
        if (Math.abs(dy) > slop && Math.abs(dy) >= Math.abs(dx)) return cancel(), null;
        if (Math.abs(dx) <= slop) return null;
        // …and it has to travel the one way the drawer can still go.
        if (wasOpen ? dx > 0 : dx < 0) return cancel(), null;
        phase = "drag";
      }
      trail.push({ x, at });
      // Keep one sample from before the window so there is always something to
      // measure against, even at the first move after the finger landed.
      while (trail.length > 2 && at - trail[1].at >= window) trail.shift();
      progress = Math.min(1, Math.max(0, (wasOpen ? width + dx : dx) / width));
      return { progress };
    },
    /** The finger left. Where the drawer settles, or null if this was never a
     *  drag and whatever else was going to happen should happen. */
    end() {
      if (phase !== "drag") return cancel(), null;
      cancel();
      // Speed as the finger left, not over the whole gesture: one that drags
      // the drawer halfway, stops to think and lets go there is asking for the
      // position to decide, not for the trip it took to get there.
      const first = trail[0];
      const last = trail[trail.length - 1];
      const elapsed = last.at - first.at;
      const speed = elapsed > 0 ? (last.x - first.x) / elapsed : 0;
      if (Math.abs(speed) >= flick) return { open: speed > 0 };
      return { open: progress > 0.5 };
    },
    cancel,
  };
}

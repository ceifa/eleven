import assert from "node:assert/strict";
import test from "node:test";
import { DISMISS_DISTANCE, MAX_SCALE, dismisses, pinchScale } from "../src/dashboard/public/lightbox.js";

test("a pinch zooms by how far the fingers spread, within bounds", () => {
  assert.equal(pinchScale(1, 100, 200), 2);
  assert.equal(pinchScale(2, 100, 150), 3);
  // Pinching in past the fitted size stops at it — the picture never shrinks
  // into a stamp in the middle of the dark.
  assert.equal(pinchScale(1, 200, 50), 1);
  assert.equal(pinchScale(4, 100, 1000), MAX_SCALE);
  // Two fingers landing on the same pixel must not divide by zero.
  assert.ok(Number.isFinite(pinchScale(1, 0, 40)));
});

test("a drag throws the picture away when it goes far enough, or fast enough", () => {
  assert.equal(dismisses(DISMISS_DISTANCE + 1, 1000), true);
  assert.equal(dismisses(-(DISMISS_DISTANCE + 1), 1000), true, "up works as well as down");
  assert.equal(dismisses(60, 400), false, "a slow nudge settles back");
  assert.equal(dismisses(60, 60), true, "a flick does not have to travel");
  assert.equal(dismisses(10, 5), false, "a twitch at the start of a tap is not a flick");
});

/* A picture in a message, opened: the whole screen, black, the picture fitted
   to it. On a phone it answers the fingers the way a photo viewer does — pinch
   to zoom, drag to look around a zoomed one, double tap to zoom in and back,
   and a drag down (or up) to throw it away. The page underneath never zooms:
   that is what the browser would do with a pinch left to itself, and a page
   left zoomed after the picture closed is a page nobody can use.

   The gesture arithmetic is exported on its own so it can be run without a
   screen; `openLightbox` is only the DOM around it. */

/** How far a drag at rest has to carry the picture before letting go closes it. */
export const DISMISS_DISTANCE = 110;
/** …or how fast, in px/ms, for a flick that never got that far. */
export const DISMISS_SPEED = 0.6;
export const MAX_SCALE = 5;
/** Two taps closer together than this are one double tap. */
export const DOUBLE_TAP_MS = 300;

/** The zoom a pinch has reached: where it started, times how far the two
 *  fingers have spread since. Never below the fitted size, never absurd. */
export const pinchScale = (startScale, startDistance, distance) =>
  Math.min(MAX_SCALE, Math.max(1, (startScale * distance) / (startDistance || 1)));

/** Whether a drag of the picture at its fitted size, let go here, closes it. */
export const dismisses = (dy, elapsedMs) =>
  Math.abs(dy) > DISMISS_DISTANCE || (elapsedMs > 0 && Math.abs(dy) / elapsedMs > DISMISS_SPEED && Math.abs(dy) > 24);

const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>`;
const OPEN_ICON = `<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 7.8 8.2M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>`;

/**
 * Open `url` over the page. It takes a history entry, so the back gesture — on
 * Android the only back there is — closes the picture rather than the thread.
 */
export function openLightbox(url, alt = "") {
  document.querySelector(".lightbox")?.remove();
  const img = document.createElement("img");
  img.className = "lightbox-img";
  img.src = url;
  img.alt = alt;
  img.draggable = false;

  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", alt || "Image");

  const bar = document.createElement("div");
  bar.className = "lightbox-bar";
  const original = document.createElement("a");
  original.className = "lightbox-button";
  original.href = url;
  original.target = "_blank";
  original.rel = "noopener";
  original.setAttribute("aria-label", "Open the original");
  original.innerHTML = OPEN_ICON;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "lightbox-button";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.innerHTML = CLOSE_ICON;
  bar.append(original, closeButton);
  box.append(img, bar);

  let closed = false;
  const remove = () => {
    if (closed) return;
    closed = true;
    removeEventListener("popstate", onPop);
    removeEventListener("keydown", onKey);
    box.classList.add("is-leaving");
    setTimeout(() => box.remove(), 180);
  };
  // A tap is a touchend and then a click, and both can mean "close": the second
  // must not walk history back a step further, out of the thread.
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    if (history.state?.lightbox) history.back();
    else remove();
  };
  const onPop = () => { if (!history.state?.lightbox) remove(); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  history.pushState({ ...history.state, lightbox: true }, "");
  addEventListener("popstate", onPop);
  addEventListener("keydown", onKey);
  closeButton.addEventListener("click", close);
  // A click on the dark around the picture is a click on nothing — close. The
  // touch path below decides for itself, so this is the mouse's.
  box.addEventListener("click", (event) => { if (event.target === box) close(); });

  gestures(box, img, close);
  document.body.append(box);
  closeButton.focus({ preventScroll: true });
}

function gestures(box, img, close) {
  let scale = 1;
  let x = 0;
  let y = 0;
  let start = null;
  let lastTap = 0;
  const points = (event) => [...event.touches].map((touch) => ({ x: touch.clientX, y: touch.clientY }));
  const spread = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
  const paint = (drag = 0) => {
    img.style.transform = `translate(${x}px, ${y + drag}px) scale(${scale})`;
    box.style.setProperty("--fade", String(Math.max(0.2, 1 - Math.abs(drag) / 360)));
  };
  // Every change in the number of fingers starts the gesture over from where
  // the picture is now, so lifting one finger of a pinch turns it into a pan
  // without a jump.
  const baseline = (event) => {
    const p = points(event);
    start = { p, scale, x, y, at: event.timeStamp, spread: p.length > 1 ? spread(p) : 0, moved: false };
  };

  box.addEventListener("touchstart", (event) => {
    if (event.target.closest(".lightbox-bar")) return;
    img.classList.add("is-held");
    baseline(event);
  }, { passive: true });

  box.addEventListener("touchmove", (event) => {
    if (!start) return;
    event.preventDefault(); // the page under the picture neither scrolls nor zooms
    const p = points(event);
    if (p.length > 1 && start.p.length > 1) {
      scale = pinchScale(start.scale, start.spread, spread(p));
      start.moved = true;
      return paint();
    }
    if (p.length !== 1 || start.p.length !== 1) return;
    const dx = p[0].x - start.p[0].x;
    const dy = p[0].y - start.p[0].y;
    if (Math.hypot(dx, dy) > 6) start.moved = true;
    if (scale > 1) {
      x = start.x + dx;
      y = start.y + dy;
      return paint();
    }
    paint(dy); // at the fitted size a drag is the one that throws it away
  }, { passive: false });

  box.addEventListener("touchend", (event) => {
    if (!start) return;
    if (event.touches.length) return baseline(event);
    img.classList.remove("is-held");
    const gesture = start;
    start = null;
    const end = event.changedTouches[0];
    const dy = end.clientY - gesture.p[0].y;
    if (gesture.moved) {
      if (gesture.p.length === 1 && gesture.scale === 1 && dismisses(dy, event.timeStamp - gesture.at)) return close();
      if (scale <= 1.02) { scale = 1; x = 0; y = 0; }
      return paint();
    }
    // A tap. Twice in a row zooms in on the spot, or back out; once on the
    // dark closes, the way a click there does.
    if (event.timeStamp - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0;
      if (scale > 1) { scale = 1; x = 0; y = 0; }
      else {
        scale = 2.5;
        const rect = box.getBoundingClientRect();
        x = (rect.width / 2 - end.clientX) * (scale - 1);
        y = (rect.height / 2 - end.clientY) * (scale - 1);
      }
      return paint();
    }
    lastTap = event.timeStamp;
    if (event.target === box && scale === 1) close();
  });
  box.addEventListener("touchcancel", () => { start = null; img.classList.remove("is-held"); paint(); });
}

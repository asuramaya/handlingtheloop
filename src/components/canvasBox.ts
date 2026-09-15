// THE ELEMENT'S SIZE, WITHOUT ASKING THE ELEMENT EVERY FRAME.
//
// `el.clientWidth` reads like a field and behaves like a function call into the layout engine:
// the browser must flush any pending style and layout before it can answer. Inside a
// requestAnimationFrame loop — which is where every canvas in this app lives — that is a forced
// synchronous layout on every frame, for a number that changes when the panel is resized and at
// no other time.
//
// It hides well, because a profiler charges the flush to the CALLER's SELF time, so it looks like
// the drawing is expensive. It isn't. Measured with scripts/phonelab/laglab.mjs at 4× CPU (the
// mid-tier-phone setting), CompHead's draw was the single most expensive function in the app at
// 398 ms of self time — ahead of the waveform. Skipping every painting call it made moved that to
// 364 ms. Replacing these two reads with this helper removed it from the profile entirely.
//
// A ResizeObserver reports the same number, computed after layout instead of forcing it, and only
// when it actually changes. The callback reads clientWidth/clientHeight rather than using
// `contentRect`: clientWidth includes padding and contentRect does not, and some of these boxes
// are wrappers rather than bare canvases — matching the old read exactly is worth more here than
// saving one property access that happens only on resize.

export interface CanvasBox {
  /** Element box width in CSS pixels — `el.clientWidth`, as of the last resize. */
  w: number;
  /** Element box height in CSS pixels — `el.clientHeight`, as of the last resize. */
  h: number;
  /** Stop observing. Call from the effect's cleanup, beside cancelAnimationFrame. */
  stop(): void;
}

/** Watch an element's box. The returned object is LIVE — read `.w`/`.h` each frame; they are
 *  updated for you. Observe starts immediately, so the values are correct before the first frame. */
export function watchBox(el: HTMLElement): CanvasBox {
  const box: CanvasBox = {
    w: el.clientWidth,
    h: el.clientHeight,
    stop() {
      ro.disconnect();
    },
  };
  const ro = new ResizeObserver(() => {
    box.w = el.clientWidth;
    box.h = el.clientHeight;
  });
  ro.observe(el);
  return box;
}

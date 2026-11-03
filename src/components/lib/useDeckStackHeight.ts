import { useEffect, useLayoutEffect } from "react";

/**
 * Publish the deck's CONTROL-SURFACE height as `--deck-stack-h` on the bank.
 *
 * ★ THE PROBLEM THIS SOLVES IS A GENUINE CONFLICT, not an oversight. Two things are both true
 * and, in plain CSS, incompatible:
 *   1. The deck must be exactly as tall as its controls need — anything more is dead space, and
 *      every dead pixel is one the waveform should have had. Measured at 768x1023: the control
 *      stack wants 321px and was being handed 638px, so 317px sat empty above the FX bar.
 *   2. The deck must be the SAME height on both pages, or opening an effect moves the waveform.
 * Sizing to content satisfies (1) and breaks (2), because the FX page's content is a different
 * height. Fixing the height satisfies (2) and breaks (1), because the fixed number is a guess.
 *
 * The way out is to notice that only ONE of the two pages defines the answer. The MIX page is
 * the control surface; the FX page is a panel borrowing its space. So: measure the MIX page,
 * remember it, and let the FX page fill exactly that. The deck is then content-sized AND
 * page-independent, which is what both requirements were actually asking for.
 *
 * Deliberately measured rather than declared, for the same reason as `--chin-h`: the stack's
 * height is the sum of a dozen rows whose own heights move with device metrics, pad mode, and
 * whether the stems row is showing a placeholder. Any literal here would be wrong on some phone.
 */
/** The stack's NATURAL height: what its rows need, with the published floor switched off for the
 *  measurement.
 *
 *  ★ IT USED TO READ `scrollHeight` WITH THE FLOOR STILL APPLIED, and the floor is this very value
 *  (`.bank-main { min-height: var(--deck-stack-h) }`). An element's scrollHeight is never less than
 *  its own height, so the measurement could only ever go UP: one taller moment (a resize that
 *  wrapped rows, a placeholder row, the FX page) and the deck kept that height for good, with the
 *  surplus sitting as dead space between the stem knobs and the bottom bar — the operator's
 *  screenshot, 2026-11-02. Reproduced headless: a stale 520px stack never returned to its real
 *  369px through re-renders or resizes. Clearing min-height for the read (same frame, layout only,
 *  never painted) measures the rows themselves, so the number can shrink as well as grow. */
export function naturalStackHeight(el: HTMLElement): number {
  const prev = el.style.minHeight;
  el.style.minHeight = "0px";
  const h = el.scrollHeight;
  el.style.minHeight = prev;
  return h;
}

export function useDeckStackHeight(el: HTMLElement | null, isPerform: boolean) {
  // Layout effect, no dep array: the row heights change with the same renders that change the
  // controls (pad mode, stems arriving, SHIFT), and this must land before paint or the deck
  // resizes a frame late — which reads as exactly the jiggle it exists to prevent.
  useLayoutEffect(() => {
    if (!el || !isPerform) return; // ★ only the MIX page defines the height; the FX page inherits it
    const h = naturalStackHeight(el);
    if (h > 0) el.closest<HTMLElement>(".bank")?.style.setProperty("--deck-stack-h", `${h}px`);
  });

  // …and again when the VIEWPORT changes, which re-flows the rows without re-rendering React.
  useEffect(() => {
    if (!el) return;
    const publish = () => {
      if (!isPerform) return;
      const h = naturalStackHeight(el);
      if (h > 0) el.closest<HTMLElement>(".bank")?.style.setProperty("--deck-stack-h", `${h}px`);
    };
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, isPerform]);
}

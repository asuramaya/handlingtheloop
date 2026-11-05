import { useSyncExternalStore } from "react";
import { SCALE_MAX, SCALE_MIN, SCALE_STEP, getRowScale, setRowScale, subscribeRowScale } from "./trackTable";

/** The Library's one row-size control (see trackTable.ts setRowScale). It sits INSIDE the filter
 *  field's right end where a table has one (TrackTable's .tt-filter-trail — operator, 2026-11-05:
 *  "make +- part of the bar"), and in the title row on its own where it does not (the Queue). */
export function RowsStepper({ inField = false }: { inField?: boolean }) {
  const scale = useSyncExternalStore(subscribeRowScale, getRowScale, getRowScale);
  return (
    // Drawn glyphs, not "−"/"＋" text: a font's minus and full-width plus sit at different heights
    // and widths, which is what put them visibly off centre in their boxes.
    <span className={inField ? "tt-rows-in" : "lib-head-rows"} role="group" aria-label="Row size" title="Row size">
      <button className="tt-step" onClick={() => setRowScale(scale - SCALE_STEP)} disabled={scale <= SCALE_MIN} aria-label="Smaller rows">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" /></svg>
      </button>
      <button className="tt-step" onClick={() => setRowScale(scale + SCALE_STEP)} disabled={scale >= SCALE_MAX} aria-label="Bigger rows">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6M5 2v6" /></svg>
      </button>
    </span>
  );
}

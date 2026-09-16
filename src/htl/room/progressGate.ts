// PROGRESS COALESCED AT THE SOURCE — the rate bound for anything forwarding work progress over the wire.
//
// The stem separator posts a true fraction once per SEGMENT and again per shift-TTA pass, so the raw
// rate is set by how the WORK is chunked. Forward it raw and the wire rate is bounded only by today's
// segment length: a faster GPU or a shorter segment silently raises it. That is the "throttle measures
// the wrong denominator" mistake from the other end — the same shape as the lyrics storm, where a
// last-value-wins payload crossed at the producer's rate instead of anyone's need.
//
// A step gate makes the bound a property of the GATE, not of the producer: at most one emission per
// step crossed, monotonic, so a whole run emits at most ceil(100 / step) + 1 frames no matter how
// many progress callbacks feed it.

/** Returns a gate that yields the step value to emit, or null when this progress adds nothing. */
export function makeProgressGate(step: number): (pct: number) => number | null {
  let last = -1;
  return (pct: number) => {
    if (!Number.isFinite(pct)) return null;
    const s = Math.floor(Math.max(0, Math.min(100, pct)) / step);
    if (s <= last) return null;
    last = s;
    return s * step;
  };
}

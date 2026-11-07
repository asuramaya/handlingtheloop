// SOFT TAKEOVER for an absolute hardware control (a knob or a slider whose position is the value).
//
// The control does nothing until it reaches the parameter's current value: either by resting on it
// or by sweeping THROUGH it. Then it tracks 1:1. This is what stops a physical control that is
// out of step with the screen from yanking the value the moment it is touched.
//
// `relatch` (tempo sliders): once caught, the control lets go again if the parameter was moved by
// something else since the control's last reading: SYNC, the screen, the keyboard, the auto-mixer.

export interface PickupState {
  caught: boolean;
  last: number; // the control's previous reading, 0..1
}

/** Tolerance for "already there", in 0..1 of the control's travel (~0.4%). */
export const PICKUP_EPS = 0.004;

/** One reading of the control. `cur` = the parameter's current value mapped to 0..1. Returns the
 *  new state; apply the reading only when `caught` is true. */
export function pickupStep(st: PickupState | undefined, cur: number, value: number, relatch = false): PickupState {
  const s = relatch && st?.caught && Math.abs(st.last - cur) > PICKUP_EPS ? { caught: false, last: st.last } : st;
  const caught =
    s?.caught === true ||
    Math.abs(value - cur) < PICKUP_EPS || // resting on the value (moved off it, it never CROSSES it)
    (s != null && ((s.last <= cur && value >= cur) || (s.last >= cur && value <= cur)));
  return { caught, last: value };
}

/** How much of the slider's own travel goes to closing the gap: the tempo moves at (1 ± CATCH_UP)×
 *  the slider's speed, so it keeps the slider's direction and the gap is gone after 1/CATCH_UP
 *  times its width of travel. */
export const CATCH_UP = 0.5;

/** CATCH-UP TAKEOVER for a hardware tempo slider: no dead zone, no jump, and a true midpoint.
 *  (operator, 2026-11-06: first "a dead zone in the midi when moving the tempo slider physically …
 *  in some situations", then, with the slider scaled to meet the tempo only at its end stop, "the
 *  midpoint is broken".) Plain pickup ignored the slider until it swept through the deck's tempo:
 *  after SYNC, the screen, the auto-mixer or a SHIFT+tempo key shift that ignored stretch was a
 *  dead zone. End-stop scaling fixed that, but left the slider's centre off 0 % until it hit an end.
 *  Here an out-of-step slider moves the tempo in its own direction at (1 ± CATCH_UP)× its speed:
 *  slower while the slider closes in on the tempo, faster while it pulls away. So the gap shrinks
 *  by CATCH_UP × every move. Within PICKUP_EPS the slider is caught and tracks 1:1, centre = 0 %.
 *  `apply` = the value (0..1) to set, or null. */
export function scaledTakeover(
  st: PickupState | undefined,
  cur: number,
  value: number,
  relatch = true,
): PickupState & { apply: number | null } {
  const p = pickupStep(st, cur, value, relatch);
  if (p.caught) return { ...p, apply: value };
  const last = st?.last;
  if (last == null || value === last) return { ...p, apply: null }; // first reading: nothing to move yet
  const d = value - last;
  const gap = last - cur; // slider minus tempo, before this move
  const shrink = Math.min(Math.abs(gap), Math.abs(d) * CATCH_UP);
  const newGap = gap - Math.sign(gap) * shrink;
  const next = Math.max(0, Math.min(1, value - newGap));
  const caught = Math.abs(next - value) < PICKUP_EPS;
  return { caught, last: value, apply: caught ? value : next };
}

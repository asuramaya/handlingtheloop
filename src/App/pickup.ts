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

/** SCALED TAKEOVER for a hardware tempo slider: no dead zone (operator, 2026-11-06: "a dead zone in
 *  the midi when moving the tempo slider physically … in some situations"). Plain pickup ignores
 *  the slider until it sweeps through the deck's tempo, and that ignored stretch is the dead zone:
 *  after SYNC, the screen, the auto-mixer or a SHIFT+tempo key shift moved one without the other.
 *  Here an uncaught slider still moves the value, toward the end it is heading for, by the
 *  same fraction of the remaining travel: (E − next) / (E − cur) = (E − value) / (E − last). So the
 *  first touch never jumps, every move answers at once, the value and the slider meet at the end
 *  stop, and with a small gap it is nearly 1:1. `apply` = the value (0..1) to set, or null. */
export function scaledTakeover(
  st: PickupState | undefined,
  cur: number,
  value: number,
  relatch = true,
): PickupState & { apply: number | null } {
  const p = pickupStep(st, cur, value, relatch);
  if (p.caught) return { ...p, apply: value };
  const last = st?.last;
  if (last == null || value === last) return { ...p, apply: null }; // first reading: nothing to scale yet
  const end = value > last ? 1 : 0;
  const span = end - last;
  const next = Math.abs(span) < 1e-9 ? end : end - (end - cur) * ((end - value) / span);
  const clamped = Math.max(0, Math.min(1, next));
  const caught = Math.abs(clamped - value) < PICKUP_EPS;
  return { caught, last: value, apply: clamped };
}

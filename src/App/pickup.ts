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

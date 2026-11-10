// QUANTIZE: a jump or a start lands IN STEP, on the deck's own grid size.
//
// ★ Operator, 2026-11-10: "what im after is quantize, i want it to be on the same terms as the grid
// setting". rekordbox's Quantize: with it on, play / CUE / a hot cue do not happen the instant you
// press, they happen on the grid, so an incoming track dropped mid-phrase falls in clean. Here the
// grid lock button (G, SHIFT + ◀▶ on the FLX4) is that switch and the deck's GRID SIZE (skipBeats,
// SHIFT+G) is the unit: at 1 bar a hot cue lands on the next "1", at 1 beat on the next beat.
//
// The clock it lines up with is the OTHER deck when that one is playing (so the two tracks' grids
// meet: the bar you press on lands on the other's bar line), else this deck itself (a hot cue
// mid-track keeps this track's own groove). With neither playing there is nothing to be in step
// with and the action runs at once.
//
// Phase is counted in BEATS within a cycle of `unit` beats, anchored at the grid's downbeat, so a
// 4-beat unit is the bar and a 16-beat unit is four bars from a downbeat. The action fires when the
// reference's phase reaches the TARGET's phase (where the jump lands, in its own cycle). A press a
// hair after the boundary (within LATE_BEATS) does not wait a whole unit: it fires at once and lands
// that much further in, exactly where it would be had it fired on time — the usual "pressed on the
// one, a touch late" case.
import { beatIndexBefore, beatPhase, beatTimeOffset, type Beatgrid } from "../analysis/analyze";

export interface QuantizeRef {
  grid: Beatgrid;
  pos: number; // seconds into the reference track, now
  rate: number; // its effective playback rate
}

/** How late a press can be and still fire at once (beats; capped at a quarter of the unit). */
export const LATE_BEATS = 0.125;

/** Where `t` sits in a cycle of `unit` beats counted from the grid's downbeat, in beats [0, unit). */
export function cyclePhase(g: Beatgrid, t: number, unit: number): number {
  const ph = beatPhase(g, t);
  if (!(unit > 1)) {
    const u = unit > 0 ? unit : 1;
    const x = ph % u;
    return x < 0 ? x + u : x;
  }
  let idx: number;
  const beats = g.beats;
  if (beats && beats.length >= 2) {
    const i = beatIndexBefore(beats, t);
    idx = i >= 0 ? i : Math.floor((t - beats[0]) / (beats[1] - beats[0]));
  } else idx = Math.floor((t - g.firstBeat) / g.interval);
  const d = g.downbeat ?? 0;
  const k = (((idx - d) % unit) + unit) % unit;
  return k + ph;
}

/** One beat's length (seconds of track) at `t`. */
function beatLen(g: Beatgrid, t: number): number {
  const a = beatTimeOffset(g, t, 0);
  const b = beatTimeOffset(g, t, 1);
  return b - a > 0 ? b - a : g.interval;
}

/** The quantize decision for landing at `target` on `self`'s grid against `ref`, now:
 *  either wait `waitSec` (wall seconds) and ask again, or fire now at `pos` (the target, pushed in
 *  by however late the reference already is). `fired` = a timer already waited for this, so any
 *  lateness short of half a unit is timer slack, not a missed boundary. */
export function quantizeStep(
  self: Beatgrid,
  target: number,
  ref: QuantizeRef,
  unit: number,
  fired = false,
): { waitSec: number; pos: number } {
  if (!(unit > 0) || !(self.interval > 0) || !(ref.grid.interval > 0) || !(ref.rate > 0)) return { waitSec: 0, pos: target };
  const pT = cyclePhase(self, target, unit);
  const pR = cyclePhase(ref.grid, ref.pos, unit);
  const late = (((pR - pT) % unit) + unit) % unit; // beats the reference is PAST the target's phase
  const tol = fired ? unit / 2 : Math.min(LATE_BEATS, unit / 4);
  if (late <= tol) return { waitSec: 0, pos: target + late * beatLen(self, target) };
  const wait = unit - late; // beats the reference still has to play
  return { waitSec: (wait * beatLen(ref.grid, ref.pos)) / ref.rate, pos: target };
}

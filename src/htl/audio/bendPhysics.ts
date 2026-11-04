// PITCH BEND FROM A TURNING RING, AS MOTION RATHER THAN AS TICKS.
//
// Operator, on the DDJ-FLX4's outer ring while playing: "it does something, slows or speeds in
// real time but there is missing physics to that motion". The old bend added a fixed push to the
// tempo on EVERY tick and decayed it continuously. A jog's ticks arrive in bursts (measured on that
// unit: 77% of gaps under 3 ms at speed), so the tempo moved in steps, and nothing tied the bend to
// how fast the ring was actually turning. There was no momentum, just a sawtooth.
//
// The old equation was already the right physics: d(bend)/dt = gain·velocity − bend/decay, a push
// proportional to how fast the ring turns that eases home over `decay`. What was wrong was the
// INPUT: velocity arrived as one impulse per tick, so bursts became steps. Here:
//   • the ticks rolled in a FRAME become a velocity (rolled distance / frame time), so a burst
//     inside one frame is just distance, never a spike;
//   • that velocity is lightly lowpassed (RING_TAU): the ring's own inertia;
//   • the SAME first-order equation is integrated exactly per frame.
// So the strength and the momentum are the old model's by construction (steady state velocity ×
// gain × decay; a nudge adds gain × decay × its roll of extra track travel; release eases out over
// `decay`), with the stepping removed.
// ★ A FIRST DRAFT used a fast attack and slow release. Its own tests caught that the asymmetry is
// not area-preserving: one tick travelled 2.7× further than before and a burst bent more than the
// same ticks spread out, i.e. "more physics" had quietly changed the strength.

export interface BendState {
  bend: number; // fractional tempo offset (0.1 = +10%)
  ringVel: number; // smoothed ring velocity, normalised roll per second (1 = one rate-second per second)
}

export interface BendParams {
  gain: number; // Deck.BEND_GAIN × the user's bend strength
  decay: number; // Deck.BEND_DECAY: ease-back time, seconds
  max: number; // Deck.BEND_MAX: clamp, fraction of tempo
}

/** The deck's ring-bend tuning: gain (push per unit ring velocity, × the user's Ring bend
 *  strength), decay (ease-back seconds) and clamp (fraction of tempo). */
// ★ GAIN 6 → 3 (operator, 2026-11-03: the ring while playing is "a bit too aggressive"). In steady
// state the bend's extra track travel is gain × decay × the ring's roll, so at 6 every tick (2.5 ms
// of roll) pushed the track ~2.7 ms: a slow eighth-turn nudge moved it ~243 ms, half a beat at 128
// bpm, which is a correction you overshoot. At 3 a tick is ~1.35 ms, an eighth turn ~120 ms and a
// full turn ~1 s. Settings ▸ Turntable ▸ Ring bend (0.25–2×) still scales it either way.
export const RING_BEND = { gain: 3, decay: 0.18, max: 0.6 } as const;

/** The ring's inertia: how quickly a change in turning speed shows up in the velocity estimate.
 *  Long enough to absorb a 1 ms-clock tick burst, short enough to feel immediate. */
export const RING_TAU = 0.035;

const clamp = (v: number, m: number) => (v > m ? m : v < -m ? -m : v);

/** One frame of ring physics. `rolled` = normalised roll distance accumulated since the last step
 *  (track-seconds ÷ rate), `dt` = frame time in seconds. */
export function stepBend(s: BendState, rolled: number, dt: number, p: BendParams): BendState {
  if (dt <= 0) return s;
  const inst = rolled / dt;
  const ringVel = s.ringVel + (inst - s.ringVel) * (1 - Math.exp(-dt / RING_TAU));
  // Exact step of d(bend)/dt = gain·ringVel − bend/decay with ringVel held over the frame.
  const e = Math.exp(-dt / p.decay);
  let bend = clamp(s.bend * e + p.gain * ringVel * p.decay * (1 - e), p.max);
  let rv = ringVel;
  if (Math.abs(bend) < 1e-4 && Math.abs(rv) < 1e-4) {
    bend = 0;
    rv = 0;
  }
  return { bend, ringVel: rv };
}

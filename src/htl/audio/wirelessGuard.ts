// Adaptive pre-roll guard math (#14 wireless-skip, sharpened for wireless CARPLAY).
//
// The worklet emits a silent sample + bumps an `underruns` counter every time its FIFO runs dry
// mid-playback (a real audible skip). The engine polls that counter and feeds the per-tick DELTA
// here; we return the new FIFO pre-roll reserve (in samples). Pure + unit-tested so the ramp
// behaviour can't silently regress.
//
// Why this shape — wireless CarPlay vs the Bluetooth this was first tuned for:
//   • CarPlay is Wi-Fi Direct / AWDL carrying 48 kHz AAC, NOT Bluetooth A2DP. Its clock jitter is
//     higher and burstier, and iOS exposes NO `outputLatency` to predict it → the underrun counter
//     is the ONLY signal we get. So the loop must be self-tuning and reactive-but-fast.
//   • RAMP UP FAST: a single confirmed skip jumps straight to a real cushion (the floor), not a
//     30 ms crawl — by the time you hear a skip the route already can't keep up.
//   • CAP DEEP: CarPlay needs far more headroom than A2DP did (120 ms was too shallow).
//   • STICKY FLOOR + SLOW DECAY: once sustained dropouts confirm a struggling wireless route, hold
//     a floor so intermittent micro-stutter can't decay the cushion back down into the next skip
//     (the anti-flap the symmetric decay lacked).
//   • Clean / wired output never trips it (reserve stays 0) → zero added latency the rest of the time.

export const POLL_MS = 250; // matches the worklet's ~4×/s diag cadence (was 1 s → ~1 s reaction-blind)

export interface ReserveCfg {
  step: number; // samples added per dropped tick (× burst size)
  cap: number; // ceiling
  floor: number; // sticky cushion locked in once wireless skipping is confirmed
  decay: number; // samples shed per clean window
  cleanTicksToDecay: number; // clean ticks required before shedding one decay step
}

/** Thresholds in SAMPLES, scaled to the context sample rate. */
export function reserveCfg(sampleRate: number): ReserveCfg {
  const ms = (m: number) => Math.round((sampleRate * m) / 1000);
  return {
    step: ms(40), // +40 ms per dropped tick (was 30)
    cap: ms(260), // ~260 ms ceiling — CarPlay Wi-Fi jitter headroom (was 120)
    floor: ms(70), // ~70 ms sticky cushion once wireless skipping is confirmed
    decay: ms(10), // shed ~10 ms at a time when clean
    cleanTicksToDecay: 32, // ~8 s clean at 250 ms before shedding a step (anti-flap)
  };
}

export interface ReserveState {
  reserve: number; // current pre-roll headroom (samples)
  cleanTicks: number; // consecutive clean polls
  floor: number; // 0 until a dropout burst is seen, then sticky at cfg.floor
}

export const ZERO_RESERVE: ReserveState = { reserve: 0, cleanTicks: 0, floor: 0 };

/** One poll of the guard. `underrunDelta` = new underruns since the last poll (a NEGATIVE value
 *  means the worklet counter reset on a node re-attach → treat as clean). Returns the next state. */
export function nextReserve(s: ReserveState, underrunDelta: number, cfg: ReserveCfg): ReserveState {
  const drops = underrunDelta > 0 ? underrunDelta : 0;
  if (drops > 0) {
    // Confirmed skip(s): jump straight to a real cushion (≥ floor), add more for a burst, clamp.
    const up = cfg.step * Math.min(drops, 4); // a big burst buys more, but bounded
    const floor = Math.max(s.floor, cfg.floor); // lock the sticky floor in
    const reserve = Math.min(cfg.cap, Math.max(s.reserve + up, floor));
    return { reserve, cleanTicks: 0, floor };
  }
  // Clean poll: only shed toward the sticky floor, and only after a long clean stretch.
  const cleanTicks = s.cleanTicks + 1;
  if (s.reserve > s.floor && cleanTicks >= cfg.cleanTicksToDecay) {
    return { reserve: Math.max(s.floor, s.reserve - cfg.decay), cleanTicks: 0, floor: s.floor };
  }
  return { reserve: s.reserve, cleanTicks, floor: s.floor };
}

/** Proactively pre-buffer the instant a wireless route CONNECTS (a devicechange), before the first
 *  skip — the only proactive lever on iOS. Raises the reserve to the floor and locks the floor in. */
export function primedFloor(s: ReserveState, cfg: ReserveCfg): ReserveState {
  return { reserve: Math.max(s.reserve, cfg.floor), cleanTicks: 0, floor: cfg.floor };
}

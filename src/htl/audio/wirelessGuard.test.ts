import { describe, test, expect } from "vitest";
import { nextReserve, primedFloor, reserveCfg, ZERO_RESERVE, POLL_MS, type ReserveState } from "./wirelessGuard";

// The wireless-skip pre-roll guard, sharpened for CarPlay. The engine polls the worklet's real
// underrun counter and feeds the per-tick delta here; these lock the ramp behaviour: up FAST on
// the first skip, deep CAP, sticky FLOOR + slow decay so intermittent CarPlay stutter can't shed
// the cushion into the next skip, and ZERO reserve while clean (no latency cost on wired output).

const SR = 48000; // wireless CarPlay route is 48 kHz
const cfg = reserveCfg(SR);

describe("reserveCfg", () => {
  test("scales all thresholds with the sample rate", () => {
    const a = reserveCfg(48000);
    const b = reserveCfg(44100);
    expect(a.cap).toBeCloseTo(48000 * 0.26, -1);
    expect(b.cap).toBeCloseTo(44100 * 0.26, -1);
    expect(a.cap).toBeGreaterThan(b.cap); // higher SR → more samples for the same milliseconds
  });

  test("the cap is materially deeper than the old 120 ms (CarPlay headroom)", () => {
    expect(cfg.cap).toBeGreaterThan(Math.round(SR * 0.12));
  });

  test("poll cadence matches the worklet diag (~4×/s)", () => {
    expect(POLL_MS).toBeLessThanOrEqual(250);
  });
});

describe("nextReserve — ramp up", () => {
  test("a single confirmed skip jumps STRAIGHT to the floor (no 40 ms crawl)", () => {
    const s = nextReserve(ZERO_RESERVE, 1, cfg);
    expect(s.reserve).toBeGreaterThanOrEqual(cfg.floor);
    expect(s.floor).toBe(cfg.floor); // sticky floor locked in
    expect(s.cleanTicks).toBe(0);
  });

  test("a burst adds more than a single drop, but is bounded", () => {
    const one = nextReserve(ZERO_RESERVE, 1, cfg).reserve;
    const burst = nextReserve(ZERO_RESERVE, 4, cfg).reserve;
    const huge = nextReserve(ZERO_RESERVE, 99, cfg).reserve;
    expect(burst).toBeGreaterThan(one);
    expect(huge).toBe(burst); // drops capped at 4 → no unbounded jump
  });

  test("sustained dropping climbs toward — and stops at — the cap", () => {
    let s: ReserveState = ZERO_RESERVE;
    for (let i = 0; i < 100; i++) s = nextReserve(s, 4, cfg);
    expect(s.reserve).toBe(cfg.cap);
  });

  test("never exceeds the cap", () => {
    let s: ReserveState = { reserve: cfg.cap, cleanTicks: 0, floor: cfg.floor };
    s = nextReserve(s, 4, cfg);
    expect(s.reserve).toBe(cfg.cap);
  });
});

describe("nextReserve — clean / decay", () => {
  test("clean ticks below the threshold do not move the reserve", () => {
    let s: ReserveState = { reserve: cfg.cap, cleanTicks: 0, floor: cfg.floor };
    for (let i = 0; i < cfg.cleanTicksToDecay - 1; i++) s = nextReserve(s, 0, cfg);
    expect(s.reserve).toBe(cfg.cap);
    expect(s.cleanTicks).toBe(cfg.cleanTicksToDecay - 1);
  });

  test("after a long clean stretch it sheds one decay step", () => {
    let s: ReserveState = { reserve: cfg.cap, cleanTicks: 0, floor: cfg.floor };
    for (let i = 0; i < cfg.cleanTicksToDecay; i++) s = nextReserve(s, 0, cfg);
    expect(s.reserve).toBe(cfg.cap - cfg.decay);
    expect(s.cleanTicks).toBe(0); // resets after shedding
  });

  test("STICKY FLOOR: decay never drops below the floor once dropouts are confirmed", () => {
    // Confirm a struggling route (sets the sticky floor), then run clean forever.
    let s = nextReserve(ZERO_RESERVE, 4, cfg);
    for (let i = 0; i < 10_000; i++) s = nextReserve(s, 0, cfg);
    expect(s.reserve).toBe(cfg.floor); // settled AT the floor, not 0 → no flap into the next skip
    expect(s.reserve).toBeGreaterThan(0);
  });

  test("with NO floor yet (never skipped), it stays at zero — no latency on wired/clean output", () => {
    let s: ReserveState = ZERO_RESERVE;
    for (let i = 0; i < 1000; i++) s = nextReserve(s, 0, cfg);
    expect(s.reserve).toBe(0);
  });

  test("a negative delta (worklet counter reset on node re-attach) is treated as clean, not a skip", () => {
    const s = nextReserve({ reserve: cfg.floor, cleanTicks: 0, floor: cfg.floor }, -500, cfg);
    expect(s.reserve).toBe(cfg.floor); // no ramp on a reset
    expect(s.cleanTicks).toBe(1);
  });
});

describe("primedFloor — proactive prime on a wireless route connect", () => {
  test("raises a cold reserve to the floor and locks the sticky floor in", () => {
    const s = primedFloor(ZERO_RESERVE, cfg);
    expect(s.reserve).toBe(cfg.floor);
    expect(s.floor).toBe(cfg.floor);
  });

  test("never lowers an already-higher reserve", () => {
    const s = primedFloor({ reserve: cfg.cap, cleanTicks: 5, floor: cfg.floor }, cfg);
    expect(s.reserve).toBe(cfg.cap);
  });
});

describe("realistic CarPlay sequence", () => {
  test("connect → skip burst → ramps; then clean → settles at the floor, not zero", () => {
    let s: ReserveState = ZERO_RESERVE;
    // Connect (proactive prime) lands a cushion before the first skip.
    s = primedFloor(s, cfg);
    expect(s.reserve).toBe(cfg.floor);
    // A rough patch: several polls with dropouts → climbs.
    for (let i = 0; i < 6; i++) s = nextReserve(s, 2, cfg);
    const peak = s.reserve;
    expect(peak).toBeGreaterThan(cfg.floor);
    // Then a long clean stretch → decays back DOWN to the floor and holds there.
    for (let i = 0; i < 5000; i++) s = nextReserve(s, 0, cfg);
    expect(s.reserve).toBe(cfg.floor);
  });
});

import { describe, expect, test } from "vitest";
import { faderCompensated, faderX, stemBlend, STEM_GAIN_MAX } from "./autoMixer";
import { crossfadeGains } from "../audio/crossfadeCurve";

// THE LEVEL THROUGH A STEM SWAP (operator, 2026-11-04: "when it uses stems there is some dead
// spaces"). The mixer drives the crossfader linearly from the live side to the incoming side over
// the blend AND sets every stem's level from stemBlend. Summed as power over four equal-energy
// stems, relative to one deck playing alone at full.
const STEMS = ["drums", "bass", "vocals", "other"] as const;

function levelDb(p: number, bars: number, swapBar: number, keyMatch: boolean, acapella: boolean, compensate: boolean): number {
  // The mixer's swap: one BEAT from the swap bar's downbeat (the old path swapped over a bar).
  const span = compensate ? 1 / (bars * 4) : 1 / bars;
  const s = Math.min(1, Math.max(0, (p - swapBar / bars) / span));
  const raw = stemBlend(p, s, { keyMatch, acapella });
  // The old path drove the fader on a straight line; the mixer now drives it with faderX.
  const x = compensate ? faderX("stemswap", p, bars, swapBar, true) : p;
  const xg = crossfadeGains(-1 + 2 * x); // live = A (−1) → incoming = B (+1)
  const live = compensate ? faderCompensated(raw.live, xg.A) : raw.live;
  const inc = compensate ? faderCompensated(raw.inc, xg.B) : raw.inc;
  let P = 0;
  for (const k of STEMS) P += (xg.A * live[k]) ** 2 + (xg.B * inc[k]) ** 2;
  return 10 * Math.log10(P / 4);
}

const PLANS = [
  { name: "32-bar key-matched blend", bars: 32, swap: 16, km: true, aca: false },
  { name: "16-bar key-clash blend", bars: 16, swap: 8, km: false, aca: false },
  { name: "8-bar blend", bars: 8, swap: 4, km: true, aca: false },
  { name: "32-bar acapella hold", bars: 32, swap: 16, km: true, aca: true },
];

describe("stem swap level", () => {
  test("the old double fade dipped ~4.5 dB mid-blend (the dead space)", () => {
    const worst = Math.min(...Array.from({ length: 101 }, (_, i) => levelDb(i / 100, 24, 8, true, false, false)));
    expect(worst).toBeLessThan(-4);
  });

  for (const pl of PLANS) {
    test(`${pl.name}: no hole — within 2 dB of a single deck all the way through`, () => {
      for (let i = 0; i <= 100; i++) {
        const db = levelDb(i / 100, pl.bars, pl.swap, pl.km, pl.aca, true);
        expect(db, `p=${i / 100}`).toBeGreaterThan(-2);
        expect(db, `p=${i / 100}`).toBeLessThan(1);
      }
    });
  }

  test("compensation never asks a deck for more than it accepts, and silence stays silence", () => {
    const g = faderCompensated({ drums: 1, bass: 0, vocals: 0.5, other: 1 }, 0.1);
    expect(Math.max(g.drums, g.vocals, g.other)).toBeLessThanOrEqual(STEM_GAIN_MAX);
    expect(g.bass).toBe(0);
    expect(faderCompensated({ drums: 0.5, bass: 1, vocals: 0, other: 0 }, 1)).toEqual({ drums: 0.5, bass: 1, vocals: 0, other: 0 });
  });
});

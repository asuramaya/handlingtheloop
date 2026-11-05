import { describe, expect, test } from "vitest";
import { chooseEntry, mashupGains, mashupMarks } from "./mashup";
import type { Sections } from "./mixPoints";

const ON = { keyOk: true };
const OFF = { keyOk: false };

describe("mashupGains — four phrases, moves on bar lines", () => {
  const bars = 32;
  const { q1, q2, q3 } = mashupMarks(bars);

  test("starts as the old track alone", () => {
    const g = mashupGains(0, bars, ON);
    expect(g.live).toEqual({ drums: 1, bass: 1, other: 1, vocals: 1 });
    expect(Object.values(g.inc).every((v) => v === 0)).toBe(true);
  });

  test("phrase 1: the new drums under the old song, nothing else of it", () => {
    const g = mashupGains(q1 - 1, bars, ON);
    expect(g.inc.drums).toBeGreaterThan(0.6);
    expect(g.inc.drums).toBeLessThan(0.8); // under, not over
    expect(g.inc.bass).toBe(0);
    expect(g.inc.vocals).toBe(0);
    expect(g.live.bass).toBe(1);
  });

  test("phrase 3 with known matching keys: the old VOCAL alone over the new instrumental", () => {
    const g = mashupGains(q2 + 2, bars, ON);
    expect(g.live.vocals).toBe(1);
    expect(g.live.drums).toBe(0);
    expect(g.live.bass).toBe(0);
    expect(g.live.other).toBe(0);
    expect(g.inc.drums).toBeCloseTo(1);
    expect(g.inc.bass).toBe(1);
    expect(g.inc.vocals).toBe(0); // one voice at a time
  });

  test("the low end changes hands in one beat, never doubled and never empty", () => {
    for (let b = q2 - 0.1; b <= q2 + 0.4; b += 0.02) {
      const g = mashupGains(b, bars, ON);
      expect(g.live.bass + g.inc.bass).toBeCloseTo(1, 5);
    }
    expect(mashupGains(q2 + 0.25, bars, ON).inc.bass).toBe(1);
  });

  test("phrase 4: the old vocal leaves, the new one arrives after it", () => {
    const g = mashupGains(q3 + 2.5, bars, ON);
    expect(g.live.vocals).toBe(0);
    expect(g.inc.vocals).toBe(1);
    expect(mashupGains(q3 + 0.5, bars, ON).inc.vocals).toBe(0);
  });

  test("an unknown or clashing key never holds the old vocal over the new bed", () => {
    const g = mashupGains(q2 + 2, bars, OFF);
    expect(g.live.vocals).toBe(0);
    // and the old melody is gone before the new one is fully in
    expect(mashupGains(q1 + 0.5, bars, OFF).live.other).toBe(0);
  });

  test("there is always something playing — no dead bar anywhere in the blend", () => {
    for (const opts of [ON, OFF]) {
      for (let b = 0; b <= bars; b += 0.125) {
        const g = mashupGains(b, bars, opts);
        const rhythm = Math.max(g.live.drums, g.inc.drums);
        const voiceOrLead = Math.max(g.live.vocals, g.inc.vocals, g.live.other, g.inc.other);
        expect(rhythm).toBeGreaterThan(0.5);
        expect(voiceOrLead).toBeGreaterThan(0.5);
      }
    }
  });

  test("ends as the new track alone", () => {
    const g = mashupGains(bars, bars, ON);
    expect(g.inc).toEqual({ drums: 1, bass: 1, other: 1, vocals: 1 });
    expect(Object.values(g.live).every((v) => v === 0)).toBe(true);
  });
});

describe("chooseEntry — a phrase start, quiet, landing on the next section", () => {
  // 120 BPM → 2 s a bar. Intro 0–16, verse 16–48, chorus 48–80, verse 80–112, …
  const s: Sections = { starts: [0, 16, 48, 80, 112, 144], labels: ["A", "B", "C", "B", "C", "D"], firstSound: 0, lastSound: 200, duration: 210 };
  const secPerBar = 2;

  test("always returns the floor or a section start", () => {
    const e = chooseEntry(s, 32, { floor: 0, secPerBar })!;
    expect([0, ...s.starts]).toContain(e);
  });

  test("a quiet intro beats a loud verse when both land on a boundary", () => {
    // blend 16 bars = 32 s: from 0 lands on 32 (miss by 8 bars → capped), from 16 lands on 48 (exact).
    // Make 16 a LOUD verse and give the intro a 48 s landing too via a 48 s blend.
    const loud = (t: number) => (t >= 16 && t < 48 ? 1.4 : 0.4);
    expect(chooseEntry(s, 48, { floor: 0, secPerBar, energyAt: loud })).toBe(0);
  });

  test("Memories case: never the middle of a verse — the old back-count landed at body − blend", () => {
    // first repeated section = 16 (B); a 4-bar-short blend back-counted from it lands at 8, mid-intro
    // phrase; with the chorus at 48 the old rule could start at 48 − 32 = 16 + … anywhere. The
    // chooser only ever picks starts.
    for (const blend of [8, 16, 24, 32, 64]) {
      const e = chooseEntry(s, blend, { floor: 0, secPerBar, energyAt: () => 1 })!;
      expect([0, ...s.starts]).toContain(e);
    }
  });

  test("never starts past the middle of the record", () => {
    const e = chooseEntry(s, 32, { floor: 0, secPerBar, energyAt: (t) => (t > 100 ? 0 : 2) })!;
    expect(e).toBeLessThanOrEqual(s.duration / 2);
  });

  test("no structure → null (the caller falls back)", () => {
    expect(chooseEntry({ ...s, starts: [] }, 32, { floor: 0, secPerBar })).toBeNull();
  });
});

import { describe, expect, test } from "vitest";
import { DD, DD_BARS, doubleDropShape, planDoubleDrop, type DDSide } from "./doubleDrop";

// 128 BPM: a bar is 1.875 s, eight bars 15 s. Sections on 8-bar phrases.
const bar = 240 / 128;
const OUT: DDSide = {
  bpm: 128,
  key: "8A",
  energy: 0.8,
  // intro, verse, CHORUS ×3 (the hook — ties with verse go to the later), outro
  sections: { starts: [0, 15, 30, 45, 60, 75, 90, 105], labels: ["I", "V", "C", "V", "C", "V", "C", "O"], firstSound: 0, lastSound: 120, duration: 125 },
};
const INC: DDSide = {
  bpm: 128,
  key: "9A",
  energy: 0.85,
  // two intro phrases, then the body (the first label that comes back)
  sections: { starts: [0, 15, 30, 45, 60, 75], labels: ["I", "J", "V", "C", "V", "C"], firstSound: 0, lastSound: 100, duration: 110 },
};
const OPTS = { lockable: true, notBefore: 20, arc: "build" as const, lastStyle: null, perf: "standard" as const };

describe("planDoubleDrop", () => {
  test("the incoming's drop lands on the outgoing's LAST hook, eight bars of build before it", () => {
    const p = planDoubleDrop(OUT, INC, OPTS)!;
    expect(p).not.toBeNull();
    expect(p.drop).toBe(90); // the last C
    expect(p.mixOut).toBeCloseTo(90 - 8 * bar, 6);
    expect(p.incDrop).toBe(30); // INC's first body section
    expect(p.mixIn).toBeCloseTo(30 - 8 * bar, 6);
  });

  test("it only happens when it will sound right", () => {
    expect(planDoubleDrop(OUT, INC, { ...OPTS, perf: "subtle" })).toBeNull();
    expect(planDoubleDrop(OUT, INC, { ...OPTS, lockable: false })).toBeNull();
    expect(planDoubleDrop(OUT, INC, { ...OPTS, lastStyle: "doubleDrop" })).toBeNull(); // never twice running
    expect(planDoubleDrop(OUT, { ...INC, key: "10A" }, OPTS)).toBeNull(); // two steps: two hooks clash
    expect(planDoubleDrop(OUT, { ...INC, energy: 0.4 }, OPTS)).toBeNull();
    expect(planDoubleDrop(OUT, { ...INC, energy: 0.65 }, { ...OPTS, arc: "ride" })).toBeNull(); // a wind-down
    expect(planDoubleDrop(OUT, INC, { ...OPTS, notBefore: 80 })).toBeNull(); // its build is already behind us
  });

  test("the hook must hold eight bars of both drops, and the incoming needs its eight-bar lead-in", () => {
    const shortHook = { ...OUT, sections: { ...OUT.sections!, starts: [0, 15, 30, 45, 60, 75, 90, 97], lastSound: 110 } };
    expect(planDoubleDrop(shortHook, INC, OPTS)).toBeNull();
    const noIntro = { ...INC, sections: { ...INC.sections!, starts: [0, 10, 25, 40], labels: ["V", "C", "V", "C"] } };
    expect(planDoubleDrop(OUT, noIntro, OPTS)).toBeNull(); // body at 0: nothing to build with
  });
});

describe("doubleDropShape", () => {
  test("the build: the incoming creeps in dark and bass-less under the pre-chorus", () => {
    for (let b = 0; b < DD.build; b += 0.5) {
      const s = doubleDropShape(b, false, false);
      expect(s.fader).toBeLessThanOrEqual(0.35);
      expect(s.incLowDb).toBeLessThan(-20);
      expect(s.incFilter).toBeLessThan(0);
      expect(s.outLowDb).toBe(0);
    }
  });
  test("the breath drains the low end out of the room", () => {
    expect(doubleDropShape(7.8, false, true).outLowDb).toBeLessThan(-20);
  });
  test("the drop: the incoming's bass and full spectrum, the outgoing's top without its bass or voice", () => {
    const s = doubleDropShape(8, true, false);
    expect(s.incLowDb).toBe(0);
    expect(s.incFilter).toBe(0);
    expect(s.outLowDb).toBeLessThan(-20);
    expect(s.outVocal).toBe(0);
    expect(s.fader).toBe(0.5);
  });
  test("the outgoing leaves through an echo in the last two bars", () => {
    expect(doubleDropShape(DD.echoFrom - 0.1, true, false).echo).toBe(0);
    expect(doubleDropShape(DD_BARS, true, false).echo).toBeGreaterThan(0.5);
  });
});

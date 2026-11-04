import { afterEach, describe, expect, test } from "vitest";
import { BEATLOCK_ANY, BEATLOCK_MAX, setBeatlockMax, tempoLockable } from "./analyze";

// The Beat-match range setting (Settings ▸ Controls ▸ Auto-DJ): which pairs AUTO and the Smart
// Fader will beat-match, judged after half/double folding.
describe("tempoLockable and the Beat-match range", () => {
  afterEach(() => setBeatlockMax(BEATLOCK_MAX));

  test("default ±10 %: a pitch-fader pair locks, a genre gap does not", () => {
    expect(tempoLockable(124, 130)).toBe(true); // +4.8 %
    expect(tempoLockable(120, 246)).toBe(true); // double time, folds to 123: +2.5 %
    expect(tempoLockable(120, 174)).toBe(false); // folds to 87: 27.5 % apart
    expect(tempoLockable(88, 130)).toBe(false);
  });

  test("measured both ways round: 100 → 91 is as far as 91 → 100", () => {
    setBeatlockMax(0.095);
    expect(tempoLockable(100, 91)).toBe(tempoLockable(91, 100));
  });

  test("a wider setting admits more; the top admits every pair (the genre bridge)", () => {
    setBeatlockMax(0.3);
    expect(tempoLockable(124, 150)).toBe(true); // 21 %
    expect(tempoLockable(120, 174)).toBe(false); // 87 vs 120 is 38 % measured from the slower side
    setBeatlockMax(BEATLOCK_ANY);
    expect(tempoLockable(124, 174)).toBe(true); // 40.3 %
    expect(tempoLockable(120, 174)).toBe(true);
    expect(tempoLockable(100, 141.4)).toBe(true); // the worst fold there is
  });

  test("nothing to lock to is never lockable", () => {
    expect(tempoLockable(0, 120)).toBe(false);
    expect(tempoLockable(120, null)).toBe(false);
  });
});

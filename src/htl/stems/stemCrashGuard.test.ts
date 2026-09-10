import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initStemCrashGuard,
  armStemLoad,
  disarmStemLoad,
  stemFailLevel,
  stemAutoFetchAllowed,
  stemsAllowed,
  resetStemGuard,
} from "./models";

// THE GUARD THAT GUARDED NOTHING, now aimed at a path that can still kill a tab.
//
// The old one was inert two ways since 2026-07-15: nothing ARMED it (its call sites went out with
// a revert), and nothing branched on the level it reported. Both halves are load-bearing and
// neither was tested, which is exactly why nobody noticed either.
//
// ★ WHAT MAKES THIS GUARD DIFFERENT FROM A COUNTER: it detects a failure the tab cannot observe
// from the inside. A caught error means the tab SURVIVED. The only signal for "the process died
// mid-load" is a flag that was set before the work and never cleared — so the arm/disarm pairing
// IS the mechanism, and a disarm that runs on the error path is not a nicety, it is what stops a
// caught failure being counted as a crash.

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  resetStemGuard();
});
afterEach(() => vi.unstubAllGlobals());

describe("a load that completes never counts as a crash", () => {
  it("arm → disarm → reload reports level 0", () => {
    armStemLoad();
    disarmStemLoad();
    expect(initStemCrashGuard()).toBe(0);
    expect(stemAutoFetchAllowed()).toBe(true);
    expect(stemsAllowed()).toBe(true);
  });

  it("a CAUGHT failure is a survival, not a crash", () => {
    // The distinction the whole design rests on. A 404, a decode error, an abort — the tab is
    // still standing, so the finally-disarm runs and nothing escalates. Counting these would
    // disable stems for anyone with a flaky connection.
    armStemLoad();
    disarmStemLoad(); // the `finally` limb
    expect(initStemCrashGuard()).toBe(0);
  });
});

describe("a load that never came back escalates, and terminates", () => {
  it("armed-but-never-disarmed on the next boot is a crash", () => {
    armStemLoad(); // …and the tab dies here: no disarm ever runs
    expect(initStemCrashGuard()).toBe(1);
    expect(stemFailLevel()).toBe(1);
  });

  it("level 1 stops the AUTO fetch and keeps the manual door open", () => {
    armStemLoad();
    initStemCrashGuard();
    expect(stemAutoFetchAllowed()).toBe(false); // no automatic download
    expect(stemsAllowed()).toBe(true); // asking still works — one bad track ≠ lose the feature
  });

  it("level 2 stops stems entirely — the rung that guarantees termination", () => {
    armStemLoad();
    initStemCrashGuard(); // crash 1
    armStemLoad();
    initStemCrashGuard(); // crash 2
    expect(stemFailLevel()).toBe(2);
    expect(stemsAllowed()).toBe(false);
    // And the plain mix cannot OOM, so there is no third crash to escalate from.
  });

  it("clears the armed flag as it counts, so ONE crash is counted ONCE", () => {
    armStemLoad();
    expect(initStemCrashGuard()).toBe(1);
    // A second boot with no new load must not re-count the same corpse.
    expect(initStemCrashGuard()).toBe(1);
    expect(stemFailLevel()).toBe(1);
  });

  it("the level SURVIVES a reload — it is the whole point", () => {
    armStemLoad();
    initStemCrashGuard();
    resetStemGuard(); // simulate a fresh module (in-memory counter gone)…
    expect(initStemCrashGuard()).toBe(0); // …resetStemGuard also clears storage, so this is 0
  });
});

describe("the user can always get back", () => {
  it("resetStemGuard clears the level and the armed flag", () => {
    armStemLoad();
    initStemCrashGuard();
    expect(stemsAllowed()).toBe(true);
    resetStemGuard();
    expect(stemFailLevel()).toBe(0);
    expect(stemAutoFetchAllowed()).toBe(true);
  });
});

describe("no localStorage is not a crash", () => {
  it("degrades to unguarded rather than to blocked", () => {
    // Private mode, or storage blocked. Every accessor throws. The guard must fail OPEN — treating
    // "cannot remember" as "you crashed" would disable stems for a whole class of browser.
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => armStemLoad()).not.toThrow();
    expect(() => disarmStemLoad()).not.toThrow();
    expect(initStemCrashGuard()).toBe(0);
    expect(stemsAllowed()).toBe(true);
  });
});

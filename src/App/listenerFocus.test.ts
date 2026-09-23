import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, focusOf, initialFocus, nextFocus, type Focus, type FocusState } from "./listenerFocus";
import type { Intent } from "../htl/room/protocol";

// THE CHURN PROBLEM, STATED AS TESTS so the operator can argue with a behaviour rather than a plan.
//
// They ruled that a listener's view follows the host and immediately named the difficulty: a
// desktop host sees both decks and the FX rack at once, a phone sees one deck and FX only when
// opened. The measured gap list (6f00c30) turned that into a concrete hazard — the phone carries an
// explicit "showing this deck's controls" indicator, so following a host's attention from deck A to
// deck B is a pane SWITCH, and alternating between decks is not an edge case, it is what MIXING IS.
//
// So the first thing this has to get right is not what to render. It is when to REFUSE to move.

const at = (ms: number) => ms;
const ctl = (deck: "A" | "B"): Intent => ({ kind: "control", deck, param: "tempo", value: 1 } as Intent);
const fx = (deck: "A" | "B"): Intent => ({ kind: "fxParam", deck, slot: 0, param: "mix", value: 0.5 } as Intent);

/** Fold a script of [intent, time] pairs and return the final pane. */
const run = (script: [Intent, number][], start: FocusState = initialFocus()): Focus | null =>
  script.reduce((s, [i, t]) => nextFocus(s, i, at(t)), start).current;

/** How many times the listener's PANE ACTUALLY CHANGED across a script.
 *
 *  ★ THIS EXISTS BECAUSE ASSERTING THE FINAL PANE WAS VACUOUS. The first version of the
 *  anti-thrash test below checked where the listener ENDED UP, and an alternating A/B script ends
 *  on A under the correct rule AND under a naive "last deck touched wins" — so it passed against
 *  the exact behaviour it was written to forbid. Found by running the naive rule as a control, not
 *  by reading the test. Thrash is a property of the PATH, so the assertion has to count the path. */
const switches = (script: [Intent, number][], start: FocusState = initialFocus()): number => {
  let s = start;
  let n = 0;
  for (const [i, t] of script) {
    const before = s.current;
    s = nextFocus(s, i, at(t));
    if (before && s.current && (before.pane !== s.current.pane || before.deck !== s.current.deck)) n++;
  }
  return n;
};

describe("what an intent is evidence for", () => {
  it("a deck-scoped intent points at that deck", () => {
    expect(focusOf(ctl("B"))).toEqual({ pane: "deck", deck: "B" });
  });

  it("an fx param points at the FX pane for its deck — the surface with no phone slot", () => {
    expect(focusOf(fx("A"))).toEqual({ pane: "fx", deck: "A" });
  });

  it("a GLOBAL intent points nowhere, rather than at a deck it happens to mention", () => {
    // Attributing a crossfade to a deck would invent attention the host never showed. The whole
    // rule is an inference, so the inputs that carry no information must say so.
    expect(focusOf({ kind: "crossfade", value: 0.5 } as Intent)).toBeNull();
    expect(focusOf({ kind: "sync", slave: "A" } as Intent)).toBeNull();
  });
});

describe("following the host", () => {
  it("the FIRST focus is immediate — there is nothing to thrash yet", () => {
    // Hysteresis on an empty pane protects nothing and costs the listener the whole dwell window
    // staring at blank.
    expect(run([[ctl("A"), 0]])).toEqual({ pane: "deck", deck: "A" });
  });

  it("a host working one deck steadily keeps the listener there", () => {
    const script: [Intent, number][] = [0, 200, 400, 600, 800, 1000, 3000, 5000].map((t) => [ctl("A"), t]);
    expect(run(script)).toEqual({ pane: "deck", deck: "A" });
  });

  it("★ ALTERNATING DECKS DOES NOT THRASH THE SCREEN — this is the case the rule exists for", () => {
    // A host riding both channels through a transition. Under a naive "show the last deck touched"
    // rule this moves the listener's pane on every single intent.
    const script: [Intent, number][] = [];
    for (let t = 0; t <= 1600; t += 200) script.push([ctl(t % 400 === 0 ? "A" : "B"), t]);
    expect(switches(script)).toBe(0); // not "ends on A" — NEVER MOVED
    expect(run(script)).toEqual({ pane: "deck", deck: "A" });
  });

  it("a single stray touch on the other deck does not move the listener", () => {
    const script: [Intent, number][] = [
      [ctl("A"), 0], [ctl("A"), 300], [ctl("A"), 600],
      [ctl("B"), 900], // one nudge
      [ctl("A"), 1200], [ctl("A"), 1500],
    ];
    expect(switches(script)).toBe(0); // again the path, not the endpoint
    expect(run(script)).toEqual({ pane: "deck", deck: "A" });
  });

  it("but a host who COMMITS to the other deck does bring the listener along", () => {
    // The point of following. Sustained attention past the dwell, with nothing on the old pane
    // since the candidate started, and outside the cooldown.
    const script: [Intent, number][] = [[ctl("A"), 0]];
    for (let t = 3000; t <= 5000; t += 300) script.push([ctl("B"), t]);
    expect(run(script)).toEqual({ pane: "deck", deck: "B" });
    expect(switches(script)).toBe(1); // exactly once — following, not chasing
  });

  it("opening the FX rack and working in it brings the listener to the pane it cannot otherwise reach", () => {
    // The measured gap: FX has no default slot on a phone. If following never drives a listener
    // there, the host's whole FX performance is invisible to them.
    const script: [Intent, number][] = [[ctl("A"), 0]];
    for (let t = 3000; t <= 5000; t += 250) script.push([fx("A"), t]);
    expect(run(script)).toEqual({ pane: "fx", deck: "A" });
  });

  it("the cooldown holds a freshly-switched pane still even against sustained new attention", () => {
    // A screen that just changed is expensive. Two switches inside the cooldown is the shape a
    // listener experiences as flicker even when each one is individually justified.
    const script: [Intent, number][] = [[ctl("A"), 0]];
    for (let t = 3000; t <= 5000; t += 300) script.push([ctl("B"), t]); // switches to B at ~4200
    for (let t = 5100; t <= 6000; t += 300) script.push([fx("A"), t]); // immediately wants FX A
    expect(run(script)).toEqual({ pane: "deck", deck: "B" });
  });

  it("the policy numbers are named, not inlined — they are what the operator should push back on", () => {
    expect(DEFAULT_POLICY.dwellMs).toBeGreaterThan(0);
    expect(DEFAULT_POLICY.cooldownMs).toBeGreaterThan(DEFAULT_POLICY.dwellMs);
    expect(DEFAULT_POLICY.windowMs).toBeGreaterThan(DEFAULT_POLICY.cooldownMs);
  });
});

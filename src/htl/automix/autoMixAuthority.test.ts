import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canArmAutoMix } from "./autoMixAuthority";

// The operator's ruling, pinned as behaviour rather than as a comment: auto-mix is HOST ONLY
// (thread cb9000d2, decision 34075fae). See autoMixAuthority.ts for why `controlling` was the
// wrong gate and what it cost.
describe("who may arm auto-mix", () => {
  test("a solo rig arms it — the seat rules bind only inside a room", () => {
    expect(canArmAutoMix({ enabled: false, host: false })).toBe(true);
  });

  test("the host arms it, and so does the host's own second device", () => {
    expect(canArmAutoMix({ enabled: true, host: true })).toBe(true);
  });

  // ★ THE CASE THE RULING IS ABOUT. A stepped-up listener holds controlling=true and ONE deck, so
  // the old `room.controlling` gate let it send an `automix` intent — which the server then dropped,
  // because that intent carries no `deck` and canDriveIntent demands BOTH. Live-looking control,
  // nothing happening.
  test("a stage DJ does NOT, however much of the board they were granted", () => {
    expect(canArmAutoMix({ enabled: true, host: false })).toBe(false);
  });

  // The operator went further than "refuse a stage DJ": a fully-granted GUEST holding AB is also
  // refused. That is a product call about whose rig this is — it does not follow from `decks`, so
  // nothing in the audio graph would catch it being quietly relaxed back to a board check.
  test("a granted guest does NOT either — host is an account, not a permission level", () => {
    expect(canArmAutoMix({ enabled: true, host: false })).toBe(false);
  });
});

// ★ BOTH AUTO BUTTONS, NOT ONE. The floating MixQueuePanel has an AUTO button and the embedded
// library header has a second one. Gating only the panel's would have left the other live — the
// caller-versus-mutator shape that cost a crossfade guard earlier today. tsc named the second site
// the moment `canAuto` became a required prop, which is the argument for threading a real prop
// instead of reading room state in two places; this keeps that true if someone makes it optional.
describe("the refusal is visible on every control that arms it", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../components/${p}`, import.meta.url)), "utf8");

  // The main AUTO button moved from the Library header to the chin (App.tsx), 2026-11-04.
  for (const file of ["MixQueuePanel.tsx", "../App.tsx"]) {
    test(`${file}'s AUTO button is disabled when the seat may not arm`, () => {
      const src = read(file);
      expect(src, `${file} no longer threads canAuto`).toMatch(/canAuto/);
      expect(src, `${file} has an AUTO button that is never disabled`).toMatch(/disabled=\{!(?:auto\.)?canAuto\}/);
    });
  }
});

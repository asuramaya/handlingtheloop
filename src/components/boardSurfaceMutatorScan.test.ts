import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ★ THE REVERSE SCAN, WIDENED PAST THE DECK BANK. Metron's deckBankMutatorScan enumerates
// DeckControls; this one asks the same question of every other surface on the board — the mixer,
// the waveform lane, the overview rail, the I/O strip, the FX strip.
//
// The question is not academic. d29dcd1 narrowed the watch-only shield off the lanes so a listener
// could LOOK, and three things came out of cover that nobody had listed: SongOverview's two drop
// paths (Metron, 36ba172) and the lane's grid-size buttons, found by running exactly this scan and
// guarded in the same commit as this file. A shield is not an enumeration, and "the blocker list
// is empty" is only ever true of the list.
//
// A handler that reaches `deck.` / `engine.` / `emit(` / `sampler.` must check the lock, take it
// from a prop that gates it (`disabled`, a `locked ?` ternary), or be named EXEMPT with a reason.
const DIR = __dirname;

// ★ THE FILE LIST IS DERIVED, NOT WRITTEN. A hand-written list is one delete away from passing
// vacuously — a control proved exactly that against the first version of this file: removing
// "DeckLane.tsx" left nine green tests and nothing to say the lane had stopped being checked.
// Reading the directory means a NEW component is covered the day it lands, which is the failure
// this scan exists for.
//
// DeckControls is excluded because deckBankMutatorScan already enumerates it, and it knows about
// that file's guarded wrappers (`act(`, `jog(`) which a generic scan would misread as unguarded.
const OWNED_ELSEWHERE = new Set(["DeckControls.tsx"]);
const HANDLER = /on(Click|Change|PointerDown|PointerUp|Tap|Input)=\{/g;
const MUTATES = /(deck\.|engine\.|emit\(|sampler\.)/;
const GUARDED = /if \(locked\) return|locked \?|!locked|disabled/;

// EXEMPT is a claim someone has to defend, not a place to put the awkward ones.
const EXEMPT: { match: string; because: string }[] = [
  {
    match: "engine.setMicDuck(v)",
    because:
      "the mic's talkover duck is this device's OWN monitoring path — it never reaches the mix or the room. Whether a listener keeps their mic at all is an open product question for the operator; locking it here would answer that question by accident.",
  },
  {
    match: "engine.setMicRoute(d)",
    because: "same: where this device's own microphone goes. Local audio, no intent, no shared state.",
  },
];

function sources(): { f: string; src: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx") && !OWNED_ELSEWHERE.has(f))
    .map((f) => ({ f, src: readFileSync(join(DIR, f), "utf8") }));
}

function unguardedIn(src: string): string[] {
  const opens = [...src.matchAll(HANDLER)].map((m) => m.index ?? 0);
  const out: string[] = [];
  opens.forEach((at, i) => {
    const end = Math.min(opens[i + 1] ?? src.length, at + 400);
    const body = src.slice(at, end);
    if (!MUTATES.test(body)) return;
    if (GUARDED.test(body)) return;
    if (EXEMPT.some((e) => body.includes(e.match))) return;
    out.push(`line ${src.slice(0, at).split("\n").length}: ${body.split("\n")[0].trim().slice(0, 70)}`);
  });
  return out;
}

describe("every component's mutating handlers are enumerated", () => {
  const all = sources();

  it("reads the directory and finds handlers (a zero here would make the scan vacuous)", () => {
    expect(all.length).toBeGreaterThan(10);
    const total = all.reduce((n, { src }) => n + [...src.matchAll(HANDLER)].length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("still covers the surfaces the watch-only shield stopped covering", () => {
    const names = all.map((c) => c.f);
    expect(names).toEqual(expect.arrayContaining(["DeckLane.tsx", "SongOverview.tsx", "FxStrip.tsx", "BoardIo.tsx"]));
  });

  it("no component mutates from an unguarded handler", () => {
    const found = all.flatMap(({ f, src }) => unguardedIn(src).map((l) => `${f} ${l}`));
    expect(found, `unguarded mutating handlers — guard them, or add them to EXEMPT with a reason:\n${found.join("\n")}`).toEqual([]);
  });
});

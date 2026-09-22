import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ★ THE REVERSE SCAN. The other lock tests name the handlers they check, so they can only catch a
// regression in a handler somebody already thought about. This one starts from the FILE: every
// pointer handler in the deck bank that mutates a deck or broadcasts an intent must check `locked`,
// and anything that does not has to be named here with a reason. That is what turns "we guarded the
// five we found" into "the bank is enumerated" — and each of the last three passes found one more
// control nobody had listed, which is exactly the failure this shape prevents.
//
// Not pure, and deliberately a source scan: these handlers need a DOM, a real Deck and a room.
const SRC = readFileSync(join(__dirname, "DeckControls.tsx"), "utf8");
const HANDLER = /on(Click|Change|PointerDown|Tap)=\{/g;
// Reaches the engine or the wire — i.e. drives.
const MUTATES = /(deck\.|emit\()/;
// Wrappers that carry the guard themselves, so a call site through them is already covered.
const GUARDED_BY_WRAPPER = /(\bact\(|\bjog\()/;

// EXEMPT, each with the reason it is not driving. A new entry here is a claim someone has to defend.
const EXEMPT: { match: string; because: string }[] = [
  { match: "changePadMode(eff)", because: "changePadMode guards on locked in its own body" },
  { match: "deck.setCueLevel(v)", because: "headphone cue is this device's OWN monitoring — local, like the mic; never reaches the mix or the room" },
  { match: "onCyclePitchRange()", because: "cycles the pitch fader's RANGE, a display scale on this device; it moves no audio" },
];

describe("deck bank mutators are enumerated", () => {
  const opens = [...SRC.matchAll(HANDLER)].map((m) => m.index ?? 0);

  it("finds handlers at all (a zero here would make the scan vacuous)", () => {
    expect(opens.length).toBeGreaterThan(20);
  });

  it("every mutating handler either guards on locked, goes through a guarded wrapper, or is exempt with a reason", () => {
    const unguarded: string[] = [];
    opens.forEach((at, i) => {
      const end = Math.min(opens[i + 1] ?? SRC.length, at + 400);
      const body = SRC.slice(at, end);
      if (!MUTATES.test(body)) return;
      if (/if \(locked\) return/.test(body) || GUARDED_BY_WRAPPER.test(body)) return;
      if (EXEMPT.some((e) => body.includes(e.match))) return;
      unguarded.push(`line ${SRC.slice(0, at).split("\n").length}: ${body.split("\n")[0].trim().slice(0, 70)}`);
    });
    expect(unguarded, `unguarded mutating handlers — guard them, or add them to EXEMPT with a reason:\n${unguarded.join("\n")}`).toEqual([]);
  });
});

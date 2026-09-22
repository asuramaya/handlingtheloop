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
// ★ TWO HOLES THIS SCAN HAD, BOTH OF WHICH ITS OWN HEADER DENIED. It said it "starts from the FILE:
// every pointer handler in the deck bank", which is the closed-world sentence a reader uses to stop
// looking. It enumerated neither:
//
//   1. onPointerUp was not in the handler list at all — so every RELEASE half of a press-and-hold
//      (cue hold, roll, hot-cue preview) was outside the scan.
//   2. It read only the literal handler text. `onClick={cueClick}` contains no `deck.` and no
//      `emit(`, so MUTATES was false and it was skipped — meaning any handler DELEGATING to a named
//      function was invisible, which is most of the interesting ones.
//
// cueAction fell through both and was reachable only via `.bank.locked` and the stage shield — which
// the policy note in DeckControls says in its own words is not a guard. It matters now rather than
// eventually because the listener FX fix (thread 3a1da460) removes the shield from this region by
// design, exactly as d29dcd1 did for DeckLane's unguarded onDrop.
const HANDLER = /on(Click|Change|PointerDown|PointerUp|DoubleClick|Tap)=\{/g;
/** `const name = …` bodies, so a handler that delegates is scanned at its DEFINITION. */
function definitions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*/g)) {
    const brace = src.indexOf("{", m.index ?? 0);
    if (brace < 0 || brace - (m.index ?? 0) > 200) continue;
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { out.set(m[1], src.slice(brace, i + 1)); break; }
    }
  }
  return out;
}
const DEFS = definitions(SRC);
/** Every body a handler can reach: its own text, then each named helper's body, transitively.
 *  Returned as a LIST and never concatenated — see the note on the check below. */
function chain(body: string): string[] {
  const bodies = [body];
  const seen = new Set<string>();
  for (let i = 0; i < bodies.length && i < 40; i++) {
    // ★ A GUARD COVERS EVERYTHING DOWNSTREAM OF IT, so stop descending here. Without this the scan
    // reports every private helper a guarded function calls — emitSeek, previewRelease — as an
    // unguarded mutator, which is true of the helper in isolation and false of the program. The
    // alternative, gluing the whole chain together and looking for a guard anywhere in it, is worse:
    // it passes everything, including a handler whose guard has been deleted. Neither the helper nor
    // the concatenation is the unit; the FIRST body that guards is.
    if (/if \(locked\) return/.test(bodies[i]) || GUARDED_BY_WRAPPER.test(bodies[i])) continue;
    for (const id of new Set(Array.from(bodies[i].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g), (x) => x[1]))) {
      if (!DEFS.has(id) || seen.has(id)) continue;
      seen.add(id);
      bodies.push(DEFS.get(id)!);
    }
    for (const id of new Set(Array.from(bodies[i].matchAll(/^\{\s*([A-Za-z_$][\w$]*)\s*\}$/g), (x) => x[1]))) {
      if (!DEFS.has(id) || seen.has(id)) continue;
      seen.add(id);
      bodies.push(DEFS.get(id)!);
    }
  }
  return bodies;
}

// Reaches the engine or the wire — i.e. drives.
const MUTATES = /(deck\.|emit\()/;
// Wrappers that carry the guard themselves, so a call site through them is already covered.
const GUARDED_BY_WRAPPER = /(\bact\(|\bjog\()/;

// EXEMPT, each with the reason it is not driving. A new entry here is a claim someone has to defend.
const EXEMPT: { match: string; because: string }[] = [
  { match: "changePadMode(eff)", because: "changePadMode guards on locked in its own body" },
  { match: "deck.setCueLevel(v)", because: "headphone cue is this device's OWN monitoring — local, like the mic; never reaches the mix or the room" },
  { match: "onCyclePitchRange()", because: "cycles the pitch fader's RANGE, a display scale on this device; it moves no audio" },
  // ★ THE RELEASE HALVES, and they are exempt for a reason that would make guarding them WRONG.
  // Each ends a press-and-hold whose PRESS is already guarded, so a locked device never starts one.
  // But `locked` can flip mid-gesture — a host revoking control while a pad is held — and a release
  // handler that returned early there would strand the roll running or the preview held, with no
  // second chance to clean up. The press is the guard; the release is the cleanup.
  { match: "onPointerUp={endRoll}", because: "release half of the roll; the press guards, and skipping the release would strand a roll if control were revoked mid-hold" },
  { match: "onPointerUp={endPadHold}", because: "release half of the hot-cue preview hold; same reason as endRoll" },
  { match: "onPointerUp={cueEndHold}", because: "release half of the CUE preview hold; cueDown guards, and this must still run to call previewRelease" },
];

describe("deck bank mutators are enumerated", () => {
  const opens = [...SRC.matchAll(HANDLER)].map((m) => m.index ?? 0);

  it("finds handlers at all (a zero here would make the scan vacuous)", () => {
    expect(opens.length).toBeGreaterThan(20);
  });

  it("resolves delegated handlers, or it is only scanning the inline ones", () => {
    // The hole that hid cueAction: if `onClick={cueClick}` is not followed to cueClick's body, a
    // whole class of handler is outside the scan while the header claims the file is enumerated.
    expect(DEFS.has("cueAction")).toBe(true);
    expect(chain("{cueClick}").join("\n")).toMatch(/deck\.(setCue|jumpToCue)/);
  });

  it("every mutating handler either guards on locked, goes through a guarded wrapper, or is exempt with a reason", () => {
    const unguarded: string[] = [];
    opens.forEach((at, i) => {
      const end = Math.min(opens[i + 1] ?? SRC.length, at + 400);
      const own = SRC.slice(at, end);
      if (EXEMPT.some((e) => own.includes(e.match))) return;
      // ★ PER BODY, NEVER OVER THE CONCATENATION. The first attempt at resolving delegated handlers
      // glued every reachable helper into one string and asked whether `if (locked) return` appeared
      // anywhere in it. It always did — the chain drags in guarded neighbours — so the check passed
      // for everything, including a cueAction with its guard deliberately deleted. An instrument
      // that cannot fail is not measuring. Each body is judged alone: the one that MUTATES is the
      // one that has to guard.
      // A wrapper is judged at the CALL SITE, not per body: act()/jog() check `locked` before they
      // ever invoke what they wrap, so the wrapped body is unreachable while locked and has nothing
      // to prove. (jog's own stored body is the inner arrow, which is why this cannot be asked of it.)
      if (GUARDED_BY_WRAPPER.test(own)) return;
      const bad = chain(own).some((b) => MUTATES.test(b) && !/if \(locked\) return/.test(b) && !GUARDED_BY_WRAPPER.test(b));
      if (!bad) return;
      unguarded.push(`line ${SRC.slice(0, at).split("\n").length}: ${own.split("\n")[0].trim().slice(0, 70)}`);
    });
    expect(unguarded, `unguarded mutating handlers — guard them, or add them to EXEMPT with a reason:\n${unguarded.join("\n")}`).toEqual([]);
  });
});

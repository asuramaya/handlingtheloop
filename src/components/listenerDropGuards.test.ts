import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { sourceFiles } from "../htl/testing/sourceScan";

// ★ A WATCH-ONLY DEVICE MUST NOT BE ABLE TO LOAD A DECK, and what used to enforce that was an
// invisible shield over the whole stage — not a guard, a cover. When the shield was narrowed to the
// control surface so a listener could LOOK (d29dcd1), every drop target outside that surface became
// reachable again. DeckLane's drop was guarded in that commit; SongOverview's was not, and it lives
// in `.lanes-flank`, which the shield never covers now — so a dragged track row or an audio file
// would have loaded a deck this device is only watching. Both its paths (the mouse drop and the
// touch equivalent) needed it.
//
// A SOURCE TEST ON PURPOSE. These handlers live in components that need a DOM and a real Deck to
// render, so there is nothing pure to call; the invariant, though, is cheap to state — a component
// that knows what `locked` means must check it in every drop path it has. It also EXTENDS ITSELF:
// a new drop target in any lock-aware component is covered the moment it is written, which is the
// failure mode here (the guard was missing in the component nobody edited).
// ★ ALL OF src/, BOTH EXTENSIONS. This scanned `readdirSync(__dirname).filter(endsWith(".tsx"))`,
// which is the same closed-world claim twice over: one directory, one extension. Every real drop
// target is a .tsx in src/components today — checked, and the only other file naming the hook is
// where it is DEFINED (src/htl/state/touchDrag.ts) — so widening changes nothing now, which is the
// argument for doing it rather than against. The invariant is about any file that knows what
// `locked` means, and the LOCK_AWARE filter below already says which those are.
const ROOT = join(__dirname, "..");
const LOCK_AWARE = /\blocked[,:]/; // takes `locked` as a prop / destructures it
const DROP_OPEN = /(onDrop=\{\(e\) => \{|useTouchDropTarget\()/g;
// ★ THE WINDOW ENDS AT THE NEXT HANDLER, NOT AT A FIXED WIDTH. A fixed slice reaches into whatever
// follows, so a NEIGHBOUR's guard reads as this handler's and a missing guard passes — Deckard hit
// exactly that in the sibling scan (deckBankLockGuards): stripping every guard still left one case
// green, because the window ran into the next declaration's surviving check. A scan whose control
// cannot fail is not a test, so the bound is the next handler opening (or the end of the file).
const WINDOW_CAP = 700;

function lockAwareComponents(): { file: string; src: string }[] {
  return sourceFiles(ROOT)
    .map(({ path, src }) => ({ file: path, src }))
    .filter((c) => LOCK_AWARE.test(c.src));
}

describe("watch-only drop guards", () => {
  const comps = lockAwareComponents();

  it("finds the lock-aware components at all (a zero here would make every case below vacuous)", () => {
    expect(comps.map((c) => c.file)).toEqual(expect.arrayContaining(["components/DeckLane.tsx", "components/SongOverview.tsx"]));
  });

  for (const { file, src } of comps) {
    const opens = [...src.matchAll(DROP_OPEN)];
    for (const m of opens) {
      const at = m.index ?? 0;
      const name = m[0].replace(/[({=].*/, "");
      const next = opens.map((o) => o.index ?? 0).find((i) => i > at) ?? src.length;
      const end = Math.min(next, at + WINDOW_CAP);
      it(`${file} · ${name} @${at} refuses a load while locked`, () => {
        expect(src.slice(at, end)).toMatch(/if \(locked\) return/);
      });
    }
  }
});

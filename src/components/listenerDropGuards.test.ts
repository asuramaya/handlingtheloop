import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const DIR = __dirname;
const LOCK_AWARE = /\blocked[,:]/; // takes `locked` as a prop / destructures it
const DROP_OPEN = /(onDrop=\{\(e\) => \{|useTouchDropTarget\()/g;

function lockAwareComponents(): { file: string; src: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((file) => ({ file, src: readFileSync(join(DIR, file), "utf8") }))
    .filter((c) => LOCK_AWARE.test(c.src));
}

describe("watch-only drop guards", () => {
  const comps = lockAwareComponents();

  it("finds the lock-aware components at all (a zero here would make every case below vacuous)", () => {
    expect(comps.map((c) => c.file)).toEqual(expect.arrayContaining(["DeckLane.tsx", "SongOverview.tsx"]));
  });

  for (const { file, src } of comps) {
    const opens = [...src.matchAll(DROP_OPEN)];
    for (const m of opens) {
      const at = m.index ?? 0;
      const name = m[0].replace(/[({=].*/, "");
      it(`${file} · ${name} @${at} refuses a load while locked`, () => {
        expect(src.slice(at, at + 700)).toMatch(/if \(locked\) return/);
      });
    }
  }
});

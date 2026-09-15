// What a rack must ADD and REMOVE to match a snapshot — the decision, extracted from the doing.
//
// ★ THE BUG THIS EXISTS TO KILL. Deck.applyFxSnapshot synced params/bypass/order for devices the
// receiver ALREADY HELD and silently dropped every kind it did not, on one line:
//
//     const idx = this.rack.indexOf(s.kind as FxKind);
//     if (idx < 0) continue; // not resident (shouldn't happen post-provision) — never re-create
//
// So a co-DJ adding a reverb never appeared for anyone else, while eq and comp — resident on both
// sides — synced perfectly. The operator's words: "i add reverb to master, other user does not see
// reverb, but eq and comp the stock fx are there and synced, just not add/removes."
//
// That comment was TRUE when membership was fixed: eq + the pad bank + comp were all permanent
// residents, so a non-resident kind really could not happen. Then a chain came to OWN its devices
// (ensurePadFx boots only eq + comp) and the ＋ button made membership variable — and this line
// never learned. A closed-world claim ("shouldn't happen") sitting in the exact place that decides
// whether to keep looking, which is the standing practice's sharpest case.
//
// ★ AND WHY IT IS A PURE FUNCTION. The fake deck in roomSim did a WHOLESALE REBUILD of the master
// chain, which adds devices — the right OUTCOME by the wrong METHOD — under a comment claiming to
// mirror the real one. So the coordination tests exercised add/remove against a fake that could not
// reproduce the bug, and passed, while the real applyFxSnapshot had no test at all (nothing
// instantiates a real Deck — it needs an AudioContext). Two closed-world claims covering for each
// other. Putting the DECISION here lets both the real deck and the fake run the same algorithm and
// lets the node suite test it, so the fake can no longer be right where the real one is wrong.

/** Kinds the master chain boots with and that nothing may delete: the channel EQ you mix with and
 *  the comp that glues it. Everything else on master is now added and removed by hand, so a
 *  snapshot omitting it is a genuine removal rather than an older peer's silence. */
export const UNDELETABLE_MASTER_KINDS: ReadonlySet<string> = new Set(["eq", "comp"]);

export interface RackDelta {
  /** Kinds present in the snapshot and missing here — create and insert these. */
  add: string[];
  /** Kinds present here and absent from the snapshot — remove these. Never an undeletable kind. */
  remove: string[];
}

/** The delta, in snapshot order for `add` so insertion follows the sender's arrangement.
 *
 *  `snapshot` must already be filtered to kinds this build understands; an unknown kind is not a
 *  removal instruction and must never reach `remove`. */
export function rackDelta(current: readonly string[], snapshot: readonly string[]): RackDelta {
  const have = new Set(current);
  const wanted = new Set(snapshot);
  return {
    add: snapshot.filter((k) => !have.has(k)),
    remove: current.filter((k) => !wanted.has(k) && !UNDELETABLE_MASTER_KINDS.has(k)),
  };
}

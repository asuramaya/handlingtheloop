// Is this stem apply a literal repeat of the set the deck's engine already holds?
//
// Applying stems is not cheap or idempotent: it restarts the pyramid build, re-packs four stems to
// int16 on the MAIN THREAD, and re-seats playback. A remote stem request that joins the host's own
// separation resumes on the same job result as the host's derive, and both used to apply it back to
// back at the moment stems land. Skipping the second apply removes that — but only a LITERAL repeat.
//
// ★ IDENTITY MUST SURVIVE THE DECK DROPPING ITS REFERENCE. The deck nulls `this.stems` after applying,
// on purpose, to free ~424 MB of float32 (synchronously on mobile; after the async pyramid build on
// desktop tracks over 8 minutes — AUTO-set length). The first version compared against `this.stems`,
// so every repeat arriving after that release saw null and did the full repack anyway. It had no test
// for "release between applies", so all its tests passed. (Metron, review of 7daebec.)
// Keeping a strong reference to the last set "so identity survives" would pin that float32 and bring
// back the iPhone jetsam crash the release exists to prevent. So identity is an ID from a WeakMap: the
// incoming set is alive (it is the argument), looking it up retains nothing, and the deck stores only
// the number.
//
// ★ AN ID THAT SURVIVES A RELEASE ALSO SURVIVES AN INVALIDATION — unless something stops it. There are
// two opposite kinds of "stems went away":
//   RELEASE       float32 dropped, the ENGINE STILL HOLDS the applied set  → the id must survive.
//   INVALIDATION  a new track, packed stems, a clear, a remote mirror      → the engine now holds
//                 something else, and the id must NOT match. Skipping there would leave the engine on
//                 the plain mix under stem controls — silently wrong, which is worse than the double
//                 work this exists to avoid.
// So a match ALSO requires the deck's own `loaded` flag (every new-track load and clear sets it false)
// and `!remote` (a remote mirror marks stems loaded with NO local set). The deck additionally resets
// the id at each invalidation site, so forgetting any single one of those guards is still safe.

const ids = new WeakMap<object, number>();
let seq = 0;

/** A stable id per stems object, held without keeping the object alive. Never reused. */
export function stemApplyId(stems: object): number {
  let id = ids.get(stems);
  if (id === undefined) {
    id = ++seq;
    ids.set(stems, id);
  }
  return id;
}

export interface HeldApply {
  /** The deck's current float32 reference. Deliberately IGNORED: it is null after a release. */
  stems: object | null;
  appliedId: number | undefined;
  loaded: boolean;
  remote: boolean;
  neural: boolean;
  videoId: string | null;
}

export interface NextApply {
  stems: object | null;
  neural: boolean;
  videoId: string | null;
}

export function isSameStemApply(held: HeldApply, next: NextApply): boolean {
  if (next.stems === null) return false; // a clear always runs — it is the plain-mix fallback
  return (
    held.loaded &&
    !held.remote &&
    // No separate `appliedId !== undefined` check: ids are numbers from 1, so undefined never matches.
    // A control that removed such a check left every test green — it could not change the result.
    held.appliedId === stemApplyId(next.stems) &&
    held.neural === next.neural &&
    held.videoId === next.videoId
  );
}

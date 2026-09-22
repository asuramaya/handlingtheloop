// The ONE geometry a stem view ships for all four stems — and whether the four agree on it.
//
// ★ WHY THIS EXISTS (thread f2b8f545). A host serialises its 4-lane stem envelope by choosing an LOD
// level PER STEM, then sending a single `bucket`, `length` and `sampleRate` for the whole view: each
// assignment in that loop overwrites the last, so the FINAL stem's geometry describes all four
// arrays. If two stems ever chose different levels, the mis-described lanes are rebuilt against the
// wrong bucket size on the receiving device, their bucket coordinate runs off the end early, and the
// viewport's interpolation path zero-fills from there — a flat trace part-way through the track, on
// SOME lanes and not others. That is exactly the shape the operator reported on 2026-09-15
// ("collapsing on some of the stems, breaking continuity").
//
// ★ WHAT THIS IS NOT: a fix. Nobody has shown the stems CAN disagree — all four come from one
// separation with one length, so the level choice should be identical — and guarding a case you
// cannot produce is speculative code. This reports, so the question stops being a reading exercise:
// if it never fires, the theory is dead and the thread closes; if it fires, this is the bug and the
// repair is a per-stem geometry on the wire, which is a schema change and needs both peers' names.
//
// It is checked at WRITE time, on the host, because that is where the geometry is chosen. The
// receiving side cannot see the disagreement in the payload — by then there IS only one bucket —
// though it can still compare the four arrays' LENGTHS, which is a different and cheaper check.

export interface StemPick {
  name: string;
  bucket: number;
  length: number;
  sampleRate: number;
}

export interface GeometryVerdict {
  agreed: boolean;
  /** Names of the stems whose geometry differs from the first stem's, in order. */
  disagreeing: string[];
}

/** Do all four stems agree on the geometry the view can carry? The FIRST pick is the reference. */
export function stemViewGeometryAgrees(picks: readonly StemPick[]): GeometryVerdict {
  if (picks.length < 2) return { agreed: true, disagreeing: [] };
  const [ref, ...rest] = picks;
  const disagreeing = rest
    .filter((p) => p.bucket !== ref.bucket || p.length !== ref.length || p.sampleRate !== ref.sampleRate)
    .map((p) => p.name);
  return { agreed: disagreeing.length === 0, disagreeing };
}

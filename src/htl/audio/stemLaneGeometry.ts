// THE RECEIVING SIDE'S HALF of the stem-view geometry question (thread f2b8f545).
//
// The host checks, at WRITE time, whether its four stems agreed about the geometry it ships for all
// of them (stemViewGeometry.ts). That check cannot run here: serialisation keeps ONE bucket, length
// and sampleRate, so by the time a view lands the disagreement it describes is gone.
//
// What DOES survive is the four lanes' own ARRAY LENGTHS. Two stems taken from different LOD levels
// give arrays of different sizes under one bucket, and the lane whose array is shorter than the
// geometry claims runs out of samples part-way through the track — the viewport zero-fills from
// there, which is a trace that goes flat mid-song on SOME lanes. That is the operator's 2026-09-15
// report, seen from the other end.
//
// So this answers a DIFFERENT question from the host's: not "did the stems disagree when chosen?"
// but "does what arrived describe itself consistently?" — which also catches anything the wire,
// the relay or an older peer mangles on the way. It REPORTS. Normalising a mis-described lane here
// would hide a host bug behind a receiver's repair, and a real fix is per-stem geometry on the
// wire, which is a schema change.

export interface StemLane {
  name: string;
  /** Samples in this lane's decoded min array (max is built alongside it and shares its length). */
  samples: number;
}

export interface LaneVerdict {
  agreed: boolean;
  /** Lanes whose sample count differs from the first lane's, in order. */
  disagreeing: string[];
  /** Buckets the view's own length/bucket pair implies, when both are usable — else null. */
  expected: number | null;
  /** Lanes that do not match `expected`. Empty when it cannot be computed. */
  shortOfClaim: string[];
}

/** Do the arrived lanes describe themselves consistently, and do they match the view's geometry? */
export function stemLaneGeometryAgrees(lanes: readonly StemLane[], view: { length: number; bucket: number }): LaneVerdict {
  if (!lanes.length) return { agreed: true, disagreeing: [], expected: null, shortOfClaim: [] };
  const [ref, ...rest] = lanes;
  const disagreeing = rest.filter((l) => l.samples !== ref.samples).map((l) => l.name);
  // A bucket of 0 or a length of 0 says nothing — an older peer, or a view built before the
  // pyramid had a length. Don't invent a claim to measure against.
  const expected = view.bucket > 0 && view.length > 0 ? Math.ceil(view.length / view.bucket) : null;
  const shortOfClaim = expected === null ? [] : lanes.filter((l) => l.samples !== expected).map((l) => l.name);
  return { agreed: disagreeing.length === 0 && shortOfClaim.length === 0, disagreeing, expected, shortOfClaim };
}

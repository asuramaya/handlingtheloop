import { describe, test, expect } from "vitest";
import { stemLaneGeometryAgrees } from "./stemLaneGeometry";

const lanes = (...counts: number[]) => ["drums", "bass", "vocals", "other"].map((name, i) => ({ name, samples: counts[i] ?? counts[0] }));

describe("stemLaneGeometryAgrees", () => {
  test("four lanes of equal length matching the view's own claim: quiet", () => {
    const v = stemLaneGeometryAgrees(lanes(400), { length: 102_400, bucket: 256 });
    expect(v).toEqual({ agreed: true, disagreeing: [], expected: 400, shortOfClaim: [] });
  });

  test("one lane from a different LOD level is named", () => {
    const v = stemLaneGeometryAgrees(lanes(400, 400, 200, 400), { length: 102_400, bucket: 256 });
    expect(v.agreed).toBe(false);
    expect(v.disagreeing).toEqual(["vocals"]);
  });

  test("lanes that agree with each other but not with the geometry are still caught", () => {
    // The wire half: every lane truncated equally still leaves the view describing more than arrived.
    const v = stemLaneGeometryAgrees(lanes(300), { length: 102_400, bucket: 256 });
    expect(v.agreed).toBe(false);
    expect(v.disagreeing).toEqual([]);
    expect(v.shortOfClaim).toEqual(["drums", "bass", "vocals", "other"]);
    expect(v.expected).toBe(400);
  });

  test("a partial final bucket counts — 401 buckets, not 400", () => {
    expect(stemLaneGeometryAgrees(lanes(401), { length: 102_500, bucket: 256 }).agreed).toBe(true);
  });

  test("an older peer with no usable geometry is not accused of anything", () => {
    const v = stemLaneGeometryAgrees(lanes(400), { length: 0, bucket: 0 });
    expect(v).toEqual({ agreed: true, disagreeing: [], expected: null, shortOfClaim: [] });
  });

  test("no lanes at all is quiet, not a crash", () => {
    expect(stemLaneGeometryAgrees([], { length: 102_400, bucket: 256 }).agreed).toBe(true);
  });
});

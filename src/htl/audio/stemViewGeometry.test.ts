import { describe, expect, it } from "vitest";
import { stemViewGeometryAgrees, type StemPick } from "./stemViewGeometry";

const pick = (name: string, over: Partial<StemPick> = {}): StemPick => ({ name, bucket: 1024, length: 9_000_000, sampleRate: 48000, ...over });
const FOUR = ["vocals", "drums", "bass", "other"].map((n) => pick(n));

describe("stemViewGeometryAgrees", () => {
  it("four stems from one separation agree — the expected case, and the one that must stay quiet", () => {
    expect(stemViewGeometryAgrees(FOUR)).toEqual({ agreed: true, disagreeing: [] });
  });
  it("a different BUCKET is the defect shape: one geometry describing arrays of another scale", () => {
    const v = stemViewGeometryAgrees([...FOUR.slice(0, 3), pick("other", { bucket: 2048 })]);
    expect(v).toEqual({ agreed: false, disagreeing: ["other"] });
  });
  it("a different LENGTH disagrees too — the lane would run off the end early", () => {
    expect(stemViewGeometryAgrees([...FOUR.slice(0, 2), pick("bass", { length: 8_000_000 }), FOUR[3]]).disagreeing).toEqual(["bass"]);
  });
  it("a different SAMPLE RATE disagrees — seconds map to buckets through it", () => {
    expect(stemViewGeometryAgrees([FOUR[0], pick("drums", { sampleRate: 44100 }), FOUR[2], FOUR[3]]).disagreeing).toEqual(["drums"]);
  });
  it("names EVERY disagreeing stem, not just the first — the report has to be actionable", () => {
    expect(stemViewGeometryAgrees([FOUR[0], pick("drums", { bucket: 512 }), pick("bass", { length: 1 }), FOUR[3]]).disagreeing).toEqual(["drums", "bass"]);
  });
  it("control: the FIRST stem is the reference, so a single stem can never disagree with itself", () => {
    expect(stemViewGeometryAgrees([pick("vocals", { bucket: 77 })]).agreed).toBe(true);
  });
});

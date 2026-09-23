import { describe, test, expect } from "vitest";
import { analysisReadme } from "./hfReadme";

// ★ THE SENTENCE AND THE NUMBER IT DESCRIBES MUST NOT BE CHANGEABLE INDEPENDENTLY, which is the
// whole reason this is a function rather than a template literal inside exportToHf. The defect this
// pins was a COMPOSITION of two correct commits: one added "an unknown number of rows" when that was
// the honest word, the other measured the number twenty-nine lines above and used it nowhere.
// Neither author saw it, because each was reading their own diff.
describe("the published README describes the blind spot it actually measured", () => {
  test("never says the size is unknown when it has been counted", () => {
    for (const n of [0, 1, 7, 12345]) {
      const md = analysisReadme({ tracks: 900, unlabelledLookups: n });
      expect(md, `said "unknown" while holding the count ${n}`).not.toMatch(/unknown number/i);
    }
  });

  test("a counted size appears in the text, not merely in the admin response", () => {
    expect(analysisReadme({ tracks: 900, unlabelledLookups: 412 })).toMatch(/\b412\b/);
  });

  // ★ A FAILED COUNT IS NOT A COUNT OF ZERO. countUnlabelledLookups swallows its own errors so an
  // export is never lost over its footnote, which means `null` reaches here on a perfectly ordinary
  // bad day. Rendering it as 0 would publish "none of our rows are mislabelled" on the strength of a
  // query that did not run — the same act as the sentence this whole thread started with.
  test("null keeps the honest word, and is not rendered as zero", () => {
    const md = analysisReadme({ tracks: 900, unlabelledLookups: null });
    expect(md).toMatch(/unknown number/i);
    expect(md).not.toMatch(/\b0 rows\b/);
    expect(md).not.toMatch(/About 0\b/);
  });

  test("zero is stated as a measurement, and still describes the lane", () => {
    const md = analysisReadme({ tracks: 900, unlabelledLookups: 0 });
    expect(md).not.toMatch(/unknown/i);
    expect(md).toMatch(/MusicBrainz/); // the lane is still explained; a zero today is not a zero forever
  });

  // Vacuity: every assertion above is a substring check, and they would all pass against a README
  // that had quietly lost the section they are about.
  test("the caveat section is present at all", () => {
    const md = analysisReadme({ tracks: 900, unlabelledLookups: 3 });
    expect(md).toMatch(/does NOT tell you/);
    expect(md).toMatch(/not a guarantee/);
    expect(md).toMatch(/900 tracks/);
  });
});

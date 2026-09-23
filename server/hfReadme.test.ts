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
      const md = analysisReadme({ tracks: 900, unlabelledLookups: n, coverage: null });
      expect(md, `said "unknown" while holding the count ${n}`).not.toMatch(/unknown number/i);
    }
  });

  test("a counted size appears in the text, not merely in the admin response", () => {
    expect(analysisReadme({ tracks: 900, unlabelledLookups: 412, coverage: null })).toMatch(/\b412\b/);
  });

  // ★ A FAILED COUNT IS NOT A COUNT OF ZERO. countUnlabelledLookups swallows its own errors so an
  // export is never lost over its footnote, which means `null` reaches here on a perfectly ordinary
  // bad day. Rendering it as 0 would publish "none of our rows are mislabelled" on the strength of a
  // query that did not run — the same act as the sentence this whole thread started with.
  test("null keeps the honest word, and is not rendered as zero", () => {
    const md = analysisReadme({ tracks: 900, unlabelledLookups: null, coverage: null });
    expect(md).toMatch(/unknown number/i);
    expect(md).not.toMatch(/\b0 rows\b/);
    expect(md).not.toMatch(/About 0\b/);
  });

  test("zero is stated as a measurement, and still describes the lane", () => {
    const md = analysisReadme({ tracks: 900, unlabelledLookups: 0, coverage: null });
    expect(md).not.toMatch(/unknown/i);
    expect(md).toMatch(/MusicBrainz/); // the lane is still explained; a zero today is not a zero forever
  });

  // Vacuity: every assertion above is a substring check, and they would all pass against a README
  // that had quietly lost the section they are about.
  test("the caveat section is present at all", () => {
    const md = analysisReadme({ tracks: 900, unlabelledLookups: 3, coverage: null });
    expect(md).toMatch(/does NOT tell you/);
    expect(md).toMatch(/not a guarantee/);
    expect(md).toMatch(/900 tracks/);
  });
});

// ★ THE NUMERATORS SHARED AN INSTANT AND THE DENOMINATOR DID NOT. a431619 made the four field
// counts one statement so they could not disagree with each other across a write, then divided them
// — here, in the README — by `tracks`, which is the length of the PAGED READ that runs afterwards.
// Care taken inside the measurement made the gap between it and its denominator easier to miss.
//
// The table moves in both directions: a contribution lands on any play, and the admin panel beside
// the export button deletes rows. A shrink publishes a percentage above 100, which is the kind of
// number that makes a reader distrust the whole file.
describe("field coverage is stated against the total it was actually counted beside", () => {
  const cov = { total: 100, bpm: 100, key: 90, beatOffset: 40, duration: 40 };

  test("a table that SHRANK during the export never publishes over 100%", () => {
    // 100 rows when counted, 80 survived to be exported — a takedown mid-export.
    const md = analysisReadme({ tracks: 80, unlabelledLookups: 0, coverage: cov });
    expect(md).toMatch(/100 \(100%\)/);
    // ★ PARSED, NOT PATTERN-MATCHED. The first version of this guard was /\(1[0-9][0-9](\.\d)?%\)/,
    // which matches "(100%)" — a legitimate value — and so failed on the correct output it was
    // written to protect. Reading the numbers out and comparing them is what the assertion actually
    // means; a regex that approximates "greater than one hundred" is a second thing to get wrong.
    const pcts = [...md.matchAll(/\((\d+(?:\.\d)?)%\)/g)].map((m) => Number(m[1]));
    expect(pcts.length, "no percentages rendered at all — the table is missing").toBeGreaterThan(0);
    expect(Math.max(...pcts), `published ${Math.max(...pcts)}%`).toBeLessThanOrEqual(100);
  });

  test("a table that GREW during the export does not understate coverage either", () => {
    const md = analysisReadme({ tracks: 130, unlabelledLookups: 0, coverage: cov });
    expect(md).toMatch(/90 \(90%\)/); // 90/100, not 90/130
  });

  test("the disagreement is stated rather than silently resolved", () => {
    const md = analysisReadme({ tracks: 80, unlabelledLookups: 0, coverage: cov });
    expect(md).toMatch(/changed during the export/);
    expect(md).toMatch(/100 rows when these were counted and 80 were exported/);
  });

  test("the usual case — no drift — says nothing extra", () => {
    const md = analysisReadme({ tracks: 100, unlabelledLookups: 0, coverage: cov });
    expect(md).toMatch(/out of 100 rows:\n/);
    expect(md).not.toMatch(/changed during the export/);
  });
});

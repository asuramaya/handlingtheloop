import { describe, it, expect } from "vitest";
import { lyricsVerdict, formatLyricsDiag } from "./diag";
import type { LyricsDiag } from "./types";

const base: LyricsDiag = {
  mode: "word",
  model: "onnx-community/whisper-base_timestamped",
  dtype: "webgpu/enc:fp32+dec:q4",
  tjs: "3.8.1",
  lines: 40,
  words: 300,
  onsets: 420,
  matched: 290,
  medianLag: 0,
  madLag: 0.04,
  driftMsPerMin: 0,
  within160: 0.95,
  decodeMs: 42000,
};
const d = (over: Partial<LyricsDiag>): LyricsDiag => ({ ...base, ...over });

describe("lyricsVerdict — the measurement must name its own fix", () => {
  it("ALIGNED: words sit on the vocals → the bug, if any, is in the render", () => {
    const v = lyricsVerdict(d({ medianLag: 0.02, madLag: 0.05 }));
    expect(v.kind).toBe("aligned");
    expect(v.ours).toBe(false);
    expect(v.fix).toMatch(/render/i);
  });

  it("★ SEGMENT: word timestamps never engaged → coarse whole-line cues, looks like misalignment", () => {
    const v = lyricsVerdict(d({ mode: "segment", words: 0, wordError: "no alignment heads" }));
    expect(v.kind).toBe("segment");
    expect(v.fix).toContain("no alignment heads");
  });

  it("★ OFFSET: a constant lag is OURS and is exactly fixable by shifting", () => {
    const v = lyricsVerdict(d({ medianLag: -0.35, madLag: 0.05 }));
    expect(v.kind).toBe("offset");
    expect(v.ours).toBe(true);
    expect(v.headline).toContain("LATE"); // negative lag = the vocal starts BEFORE Whisper said
    expect(v.fix).toMatch(/-350 ms/);
  });

  it("OFFSET headline says EARLY when the real vocal starts after Whisper's word", () => {
    expect(lyricsVerdict(d({ medianLag: 0.4, madLag: 0.05 })).headline).toContain("EARLY");
  });

  it("★ DRIFT beats OFFSET: a drifting error also has a non-zero median, but drift is the real name", () => {
    // This is the case a naive reading would misdiagnose as a constant offset and "fix" with a
    // shift — which would leave the start right and the end just as wrong.
    const v = lyricsVerdict(d({ medianLag: -0.4, madLag: 0.06, driftMsPerMin: -260 }));
    expect(v.kind).toBe("drift");
    expect(v.ours).toBe(true);
    expect(v.fix).toMatch(/no model change will help/i);
  });

  it("★ SCATTER: centred but wild → the MODEL is guessing; no offset can save it", () => {
    const v = lyricsVerdict(d({ medianLag: 0.01, madLag: 0.4 }));
    expect(v.kind).toBe("scatter");
    expect(v.ours).toBe(false);
    expect(v.fix).toMatch(/forced alignment|DTW/i);
  });

  it("a big offset WITH big scatter is scatter, not offset — shifting it would be a lie", () => {
    expect(lyricsVerdict(d({ medianLag: 0.3, madLag: 0.5 })).kind).toBe("scatter");
  });

  it("flags OUR failure when the words don't sit near any onset at all", () => {
    const v = lyricsVerdict(d({ matched: 20, words: 300 }));
    expect(v.kind).toBe("unknown");
    expect(v.ours).toBe(true);
  });

  it("tolerances are musical: 80 ms is fine, 200 ms is not", () => {
    expect(lyricsVerdict(d({ medianLag: 0.08, madLag: 0.05 })).kind).toBe("aligned");
    expect(lyricsVerdict(d({ medianLag: 0.2, madLag: 0.05 })).kind).toBe("offset");
  });

  it("★ surfaces that the shipped ±160 ms snap cannot even REACH a large offset", () => {
    // The snap silently no-ops when the error exceeds its window — which is why alignment
    // looked 'fixed' while nothing had been fixed at all.
    const v = lyricsVerdict(d({ medianLag: -0.5, madLag: 0.05, within160: 0.04 }));
    expect(v.fix).toMatch(/4% of these words/);
  });
});

describe("formatLyricsDiag", () => {
  it("leads with the verdict and the fix, then the evidence", () => {
    const rows = formatLyricsDiag(d({ medianLag: -0.35, madLag: 0.05 }));
    expect(rows[0][0]).toBe("verdict (raw model)");
    expect(rows[0][1]).toMatch(/^OFFSET/);
    expect(rows[1][0]).toBe("fix");
    expect(rows.find((r) => r[0] === "fault")?.[1]).toMatch(/OURS/);
    expect(rows.find((r) => r[0] === "transformers.js")?.[1]).toBe("3.8.1");
  });

  it("★ reports what the ALIGNER did — and says plainly when it declined to act", () => {
    const acted = formatLyricsDiag(
      d({ medianLag: -0.35, align: { bias: 0.35, drift: 0.0002, snapped: 280, free: 20, medianMove: 0.34, applied: true } }),
    ).find((r) => r[0] === "ALIGNER")?.[1];
    expect(acted).toMatch(/removed 350 ms offset/);
    expect(acted).toMatch(/280\/300 words placed on a real vocal onset/);

    // An aligner that quietly does nothing is the bug we are replacing. If it declines, it SAYS so.
    const declined = formatLyricsDiag(
      d({ align: { bias: 0, drift: 0, snapped: 0, free: 300, medianMove: 0, applied: false } }),
    ).find((r) => r[0] === "ALIGNER")?.[1];
    expect(declined).toMatch(/DECLINED/);
  });
});

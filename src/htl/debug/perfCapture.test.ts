import { describe, expect, it } from "vitest";
import { summarizePerf, type PerfCapture } from "./perfCapture";

const cap = (over: Partial<PerfCapture>): PerfCapture => ({
  kind: "htl-perf",
  version: 1,
  capturedAt: 0,
  durationMs: 10_000,
  env: {},
  frames: [],
  loafs: [],
  events: [],
  samples: [],
  marks: [],
  ...over,
});

describe("summarizePerf: the one line the operator sees before sending the file", () => {
  it("counts slow frames, long frames, slow inputs, and dropouts as a DELTA over the recording", () => {
    const s = summarizePerf(
      cap({
        frames: [...new Array(95).fill(16.7), 40, 50, 60, 70, 80],
        loafs: [{ t: 1, d: 120, block: 70, render: 5, scripts: [] }],
        events: [
          { t: 1, name: "click", d: 180, wait: 100, proc: 60, target: "button" },
          { t: 2, name: "click", d: 40, wait: 1, proc: 2, target: "button" },
        ],
        // 12 underruns already counted before recording began must not be blamed on it
        samples: [
          { t: 0, audio: { underruns: 12, outputLatencyMs: 20, state: "running", playing: true } },
          { t: 9, audio: { underruns: 15, outputLatencyMs: 20, state: "running", playing: true } },
        ],
      }),
    );
    expect(s).toContain("100 frames");
    expect(s).toContain("5 slow");
    expect(s).toContain("1 long frames");
    expect(s).toContain("1 slow inputs");
    expect(s).toContain("3 audio dropouts");
  });

  it("CONTROL: an empty recording reads as clean, not as an error", () => {
    expect(summarizePerf(cap({}))).toContain("0 frames");
  });
});

import { describe, expect, it } from "vitest";
import { analyzeChannels } from "./analyze";

// THE INLINE PATH NOW HANDS ANALYSIS THE LIVE PLAYBACK BUFFER, AND NOTHING SAID IT MUST NOT WRITE.
//
// 93257e4 removed the .slice() from analyzeTrackAsync's inline fallback, correctly: the copy existed
// to survive a TRANSFER, and with no worker there is no transfer and nothing can be detached. But it
// also did something the commit does not claim — it made "analysis never writes into the channel
// data it is given" LOAD-BEARING. Before, a stray write landed in a private copy and cost nothing.
// Now it would land in the AudioBuffer the deck is playing out of, on exactly the phones where
// constructing a Worker already failed, and the symptom would be audible corruption during a load
// with no error anywhere near the code that caused it.
//
// The invariant holds today. This pins it, because the cheapest moment to catch a write into a
// borrowed buffer is the moment someone adds one.

const stimulus = (n: number, sr: number) => {
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  let s = 7;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let t = 0.5; t < n / sr - 1; t += 60 / 126) {
    const at = Math.round(t * sr);
    for (let i = 0; i < sr * 0.22 && at + i < n; i++) {
      const u = i / sr;
      const v = Math.exp(-u * 18) * Math.sin(2 * Math.PI * (55 + 55 * Math.exp(-u * 40)) * u);
      a[at + i] += v;
      b[at + i] += v * 0.9; // genuinely different channels, or a downmix would hide a write
    }
    const h = Math.round((t + 0.21) * sr);
    for (let i = 0; i < sr * 0.03 && h + i < n; i++) {
      const e = Math.exp(-(i / sr) * 90) * 0.2;
      a[h + i] += rnd() * e;
      b[h + i] += rnd() * e;
    }
  }
  return { a, b };
};

const firstDiff = (x: Float32Array, y: Float32Array) => {
  for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return i;
  return -1;
};

describe("analysis does not write into the channels it is lent", () => {
  const SR = 48000;
  const n = SR * 24;

  it("leaves both channels byte-identical after a full analyse", () => {
    const { a, b } = stimulus(n, SR);
    const a0 = a.slice();
    const b0 = b.slice();
    const out = analyzeChannels(a, b, SR);
    // The run has to have done real work, or "nothing changed" is the answer you get from an
    // analyser that bailed on the first line.
    expect(out.beatgrid?.bpm ?? 0).toBeGreaterThan(60);
    expect(firstDiff(a, a0)).toBe(-1);
    expect(firstDiff(b, b0)).toBe(-1);
  });

  it("leaves a mono channel untouched too — the path the worker-less fallback actually takes", () => {
    const { a } = stimulus(n, SR);
    const a0 = a.slice();
    const out = analyzeChannels(a, null, SR);
    expect(out.beatgrid?.bpm ?? 0).toBeGreaterThan(60);
    expect(firstDiff(a, a0)).toBe(-1);
  });

  it("CONTROL: the comparison notices a single changed sample", () => {
    const { a } = stimulus(n, SR);
    const a0 = a.slice();
    a[Math.floor(n / 3)] += 1e-7;
    expect(firstDiff(a, a0)).toBe(Math.floor(n / 3));
  });
});

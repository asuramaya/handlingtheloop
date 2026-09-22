import { describe, it, expect } from "vitest";
import { takeRecoveryGain, bufferPeak, fitTakeToFullScale } from "./takeGain";

const buf = (...chans: number[][]) => ({
  numberOfChannels: chans.length,
  getChannelData: (c: number) => Float32Array.from(chans[c]),
});
// A buffer whose channel data is the SAME array each call, so an in-place scale is observable —
// getChannelData() returning a fresh copy would make fitTakeToFullScale look like a no-op.
const liveBuf = (...chans: number[][]) => {
  const data = chans.map((c) => Float32Array.from(c));
  return { numberOfChannels: data.length, getChannelData: (c: number) => data[c], data };
};

describe("takeRecoveryGain", () => {
  it("leaves a take that fits exactly alone — 1, not 0.9999", () => {
    expect(takeRecoveryGain(1)).toBe(1);
  });

  it("leaves a quiet take alone rather than normalising it up", () => {
    expect(takeRecoveryGain(0.4)).toBe(1); // this is a clip fix, NOT a loudness feature
  });

  it("brings the measured overshoot back to full scale — exactly, not approximately", () => {
    const measured = 1.147651; // the lossy broadband take, --codec-margin
    expect(takeRecoveryGain(measured) * measured).toBeCloseTo(1, 12);
    expect(20 * Math.log10(takeRecoveryGain(measured))).toBeCloseTo(-1.196, 3); // what the take gives up
  });

  it("treats a non-finite peak as nothing to do", () => {
    expect(takeRecoveryGain(NaN)).toBe(1);
    expect(takeRecoveryGain(Infinity)).toBe(1);
  });
});

describe("bufferPeak", () => {
  it("finds the peak across channels, not just the first", () => {
    expect(bufferPeak(buf([0.1, 0.2], [0.3, -0.9]))).toBeCloseTo(0.9, 6);
  });

  it("measures magnitude, so a negative excursion counts", () => {
    expect(bufferPeak(buf([-1.2, 0.5]))).toBeCloseTo(1.2, 6);
  });

  it("is 0 for silence, and silence is therefore left alone", () => {
    expect(bufferPeak(buf([0, 0]))).toBe(0);
    expect(takeRecoveryGain(0)).toBe(1);
  });
});

describe("fitTakeToFullScale", () => {
  it("scales an over-full-scale take so nothing would be clamped", () => {
    const b = liveBuf([1.2, -0.6], [0.3, 0.9]);
    const g = fitTakeToFullScale(b);
    expect(g).toBeCloseTo(1 / 1.2, 6);
    expect(bufferPeak(b)).toBeCloseTo(1, 6);
    expect(b.data[0][1]).toBeCloseTo(-0.5, 6); // the whole take moves together, not just the peak
  });

  // The control: if this scaled every take it would be a silent loudness change on ordinary
  // recordings, which is the operator's call and not this function's business.
  it("does NOT touch a take that already fits", () => {
    const b = liveBuf([0.5, -0.25]);
    expect(fitTakeToFullScale(b)).toBe(1);
    expect(b.data[0][0]).toBe(0.5);
  });
});

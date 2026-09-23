import { describe, expect, it } from "vitest";
import { cachedBytes, setCachedTrack, dropCachedBuffer } from "./trackCache";
import type { TrackAnalysis } from "../analysis/analyze";

// The one allocation that is ALWAYS present on a plain track load was the one nothing could count.
// stemBytes existed; mixBytes did not. These pin the arithmetic so a number in a crash report means
// what it says — 4 bytes per sample per channel, not a guess with a "~" in front of it.

const buf = (seconds: number, channels = 2, sr = 48000) =>
  ({ length: Math.round(seconds * sr), numberOfChannels: channels }) as AudioBuffer;
const analysis = { bpm: 128, key: { camelot: "8A" } } as unknown as TrackAnalysis;
const mixBytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;

describe("resident audio bytes", () => {
  it("a 4-minute 48 kHz stereo track is ~92 MB, which is the figure the cache comment quotes", () => {
    expect(mixBytes(buf(240)) / 1e6).toBeCloseTo(92.16, 1);
  });

  it("and a ten-minute one is ~230 MB — the variable a COUNT-based cap cannot see", () => {
    expect(mixBytes(buf(600)) / 1e6).toBeCloseTo(230.4, 1);
  });

  it("mono halves it, so channel count is not assumed", () => {
    expect(mixBytes(buf(240, 1))).toBe(mixBytes(buf(240, 2)) / 2);
  });

  it("cachedBytes sums what the cache is holding", () => {
    const id = `t${Math.random()}`;
    const before = cachedBytes();
    setCachedTrack(id, { buffer: buf(60), analysis });
    expect(cachedBytes() - before).toBe(mixBytes(buf(60)));
    dropCachedBuffer(id);
    expect(cachedBytes()).toBe(before);
  });

  it("CONTROL: dropping a buffer really removes it, or the sum above proves nothing", () => {
    const id = `t${Math.random()}`;
    setCachedTrack(id, { buffer: buf(30), analysis });
    const withIt = cachedBytes();
    dropCachedBuffer(id);
    expect(cachedBytes()).toBeLessThan(withIt);
  });
});

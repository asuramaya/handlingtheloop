import { describe, expect, it, vi } from "vitest";

// ★ THE MOBILE STEM LOAD MUST NOT BUILD A FLOAT32 STEM. The packed path used to decode each stem to
// planes in the worker, copy them into an AudioBuffer on the main thread and pack that — three
// full-length float32 copies of a stem in flight at once, measured at ~3.9 GB renderer RSS while the
// second deck's stems of a 20-minute pair loaded. The fix routes an htl-Opus stem at the context's
// rate straight to the worker's int16 pack. Pin that routing: if a refactor sends it back through an
// AudioBuffer, nothing audible changes and nothing else fails — only the phone dies.

const packed = (limit?: number) => ({
  L: new Int16Array(limit ?? 10),
  R: new Int16Array(limit ?? 10),
  length: limit ?? 10,
  sampleRate: 48000,
  base: { min: new Float32Array(1), max: new Float32Array(1), low: new Float32Array(1), mid: new Float32Array(1), high: new Float32Array(1), bucket: 256 },
});
const packedOff = vi.fn(async (_b: ArrayBuffer, limit?: number) => packed(limit));
const opusOff = vi.fn(async () => {
  throw new Error("float32 decode must not run on the packed path");
});
vi.mock("./opusWorker", () => ({ decodeStemPackedOffThread: packedOff, decodeStemOpusOffThread: opusOff }));
const decodeAudio = vi.fn();
vi.mock("../audio/decode", () => ({ decodeAudio }));

/** A minimal htl-Opus header: magic "HTO1", stored rate, channels. */
function opusBlob(rate: number): ArrayBuffer {
  const b = new ArrayBuffer(16);
  const dv = new DataView(b);
  dv.setUint32(0, 0x48544f31, false);
  dv.setUint32(4, rate, true);
  new Uint8Array(b)[8] = 2;
  return b;
}

describe("decodePackStem — the mobile stem path never holds a float32 stem", () => {
  it("Opus at the context rate goes straight to the worker's int16 pack (no AudioBuffer, no decodeAudioData)", async () => {
    const { decodePackStem } = await import("./index");
    const createBuffer = vi.fn();
    const ctx = { sampleRate: 48000, createBuffer } as unknown as BaseAudioContext;
    const first = await decodePackStem(ctx, opusBlob(48000));
    const later = await decodePackStem(ctx, opusBlob(48000), 7); // later stems are held to the set's length
    expect(first.L).toBeInstanceOf(Int16Array);
    expect(later.length).toBe(7);
    expect(packedOff).toHaveBeenCalledTimes(2);
    expect(packedOff.mock.calls[1][1]).toBe(7);
    expect(opusOff).not.toHaveBeenCalled();
    expect(decodeAudio).not.toHaveBeenCalled();
    expect(createBuffer).not.toHaveBeenCalled();
  });

  it("a context at another rate (44.1 kHz) still needs the resample, so it takes the AudioBuffer route — one stem at a time", async () => {
    const { decodePackStem } = await import("./index");
    packedOff.mockClear();
    const n = 300;
    const ch = new Float32Array(n).fill(0.5);
    opusOff.mockImplementationOnce(async () => ({ length: n, sampleRate: 44100, numberOfChannels: 2, getChannelData: () => ch }) as unknown as never);
    const ctx = { sampleRate: 44100 } as unknown as BaseAudioContext;
    const out = await decodePackStem(ctx, opusBlob(48000));
    expect(packedOff).not.toHaveBeenCalled();
    expect(out.length).toBe(n);
    expect(out.L[0]).toBe(Math.round(0.5 * 32767));
  });
});

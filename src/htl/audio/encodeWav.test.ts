import { describe, it, expect } from "vitest";
import { bufferToWav } from "./encodeWav";

// A minimal stand-in for the Web Audio AudioBuffer (bufferToWav only reads numberOfChannels /
// length / sampleRate / getChannelData). Channels are passed as plain number[][].
function fakeBuffer(channels: number[][], sampleRate = 48000): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    getChannelData: (c: number) => Float32Array.from(channels[c]),
  } as unknown as AudioBuffer;
}

async function view(b: Blob): Promise<DataView> {
  return new DataView(await b.arrayBuffer());
}
const str = (dv: DataView, off: number, n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(dv.getUint8(off + i))).join("");

describe("bufferToWav — header", () => {
  it("writes a well-formed 44-byte PCM WAV header for stereo", async () => {
    const dv = await view(bufferToWav(fakeBuffer([[0, 0, 0], [0, 0, 0]], 44100)));
    expect(str(dv, 0, 4)).toBe("RIFF");
    expect(str(dv, 8, 4)).toBe("WAVE");
    expect(str(dv, 12, 4)).toBe("fmt ");
    expect(dv.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(2); // channels
    expect(dv.getUint32(24, true)).toBe(44100); // sample rate
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample
    expect(str(dv, 36, 4)).toBe("data");
    const dataLen = 3 /*frames*/ * 2 /*ch*/ * 2 /*bytes*/;
    expect(dv.getUint32(40, true)).toBe(dataLen);
    expect(dv.getUint32(4, true)).toBe(36 + dataLen); // RIFF size
    expect(dv.byteLength).toBe(44 + dataLen);
  });

  it("byteRate = rate * blockAlign and blockAlign = channels * 2", async () => {
    const dv = await view(bufferToWav(fakeBuffer([[0], [0]], 48000)));
    expect(dv.getUint16(32, true)).toBe(4); // blockAlign 2ch * 2 bytes
    expect(dv.getUint32(28, true)).toBe(48000 * 4); // byteRate
  });

  it("mono: one channel, blockAlign 2", async () => {
    const dv = await view(bufferToWav(fakeBuffer([[0, 0]], 22050)));
    expect(dv.getUint16(22, true)).toBe(1);
    expect(dv.getUint16(32, true)).toBe(2);
    expect(dv.getUint32(40, true)).toBe(2 * 1 * 2); // 2 frames mono
  });

  it("caps at 2 channels (a surround buffer is downmixed to stereo width)", async () => {
    const dv = await view(bufferToWav(fakeBuffer([[0], [0], [0], [0]], 48000)));
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(40, true)).toBe(1 * 2 * 2);
  });
});

describe("bufferToWav — int16 sample scaling", () => {
  // Read interleaved little-endian int16 frames starting at the 44-byte data offset.
  async function samples(b: Blob): Promise<number[]> {
    const dv = await view(b);
    const out: number[] = [];
    for (let off = 44; off + 1 < dv.byteLength; off += 2) out.push(dv.getInt16(off, true));
    return out;
  }

  it("maps the full-scale endpoints: -1 → -32768, +1 → +32767, 0 → 0", async () => {
    expect(await samples(bufferToWav(fakeBuffer([[-1, 0, 1]])))).toEqual([-32768, 0, 32767]);
  });

  it("clamps out-of-range samples to [-1, 1] before scaling", async () => {
    expect(await samples(bufferToWav(fakeBuffer([[-2, 2, -1.5, 1.5]])))).toEqual([-32768, 32767, -32768, 32767]);
  });

  it("interleaves stereo frames L,R,L,R", async () => {
    // L = [1, -1], R = [0, 1] → frames: (1,0)(−1,1) → 32767, 0, −32768, 32767
    expect(await samples(bufferToWav(fakeBuffer([[1, -1], [0, 1]])))).toEqual([32767, 0, -32768, 32767]);
  });

  it("scales a mid value by the sign-dependent factor (neg ×0x8000, pos ×0x7fff)", async () => {
    const [neg, pos] = await samples(bufferToWav(fakeBuffer([[-0.5, 0.5]])));
    expect(neg).toBe(Math.trunc(-0.5 * 0x8000)); // -16384
    expect(pos).toBe(Math.trunc(0.5 * 0x7fff)); // 16383
  });
});

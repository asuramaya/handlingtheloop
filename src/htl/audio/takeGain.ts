// A take that comes back above full scale, and what to do about it. Thread 3495e865.
//
// On a browser with no lossless capture format (Safari/iOS offers mp4/AAC only) a take is a lossy
// round trip by necessity, and a decoded lossy signal sits ABOVE what went in — the codec
// reconstructs a waveform, not the samples. Measured on a hot broadband mix through the real
// capture path (`node scripts/fxlab/fxlab.mjs --codec-margin`): the master brickwall handed the
// recorder a 0.966 peak and the lossy take read back 1.1477 — 1.50 dB of codec overshoot, against
// the 0.300 dB of room the ceiling leaves. A steady sine overshoots by 0.22 dB, which is why this
// looked survivable until it was measured on material a set is actually made of.
//
// bufferToWav encodes 16-bit PCM and CLAMPS at ±1, so those samples would be flattened: audible
// distortion in the saved file while the limiter was never in reduction — "the recording sounds
// crunchier than the set did".
//
// The choice here is between a clipped take and a quieter one, and it is only ever offered for a
// take that would be damaged: below full scale this returns exactly 1 and nothing is touched.
export function takeRecoveryGain(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 1) return 1;
  return 1 / peak;
}

/** The largest |sample| across a buffer's channels — what the encoder is about to clamp against. */
export function bufferPeak(buffer: { numberOfChannels: number; getChannelData: (c: number) => Float32Array }): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i] < 0 ? -d[i] : d[i];
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Scale a take down to fit the encoder, in place. Returns the gain applied (1 = untouched). */
export function fitTakeToFullScale(buffer: { numberOfChannels: number; getChannelData: (c: number) => Float32Array }): number {
  const g = takeRecoveryGain(bufferPeak(buffer));
  if (g === 1) return 1;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return g;
}

/** Mono int16 at native rate (chromaprint resamples) from one or two float channels, first `frames`
 *  samples. Shared by the worker and the in-thread fallback so both fingerprint identically. */
export function downmixInt16(ch0: Float32Array, ch1: Float32Array | null, frames: number): Int16Array {
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    pcm[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return pcm;
}

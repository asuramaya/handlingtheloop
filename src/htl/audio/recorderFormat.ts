// Which container/codec a take is captured in. Thread 307cb25b: a take read back 0.06 dB ABOVE the
// master limiter's own ceiling, which the limiter's code says cannot happen — and it wasn't the
// limiter. `new MediaRecorder(stream)` with no mimeType means webm/OPUS on Chromium, so every take
// was a LOSSY ROUND TRIP: the codec reconstructs a waveform rather than the samples, and the decoded
// signal sits above what went in (measured at 0.221 dB on a capped sine, four times the anomaly).
//
// That overshoot is not cosmetic. stop() re-encodes the decoded buffer with bufferToWav, which
// CLAMPS at ±1 — so a take can hard-clip on save while the limiter did its job perfectly.
//
// The fix is to capture losslessly where the browser offers it. It often doesn't (Safari/iOS gives
// mp4/AAC only), so this returns undefined rather than a format nobody can record, and the caller
// falls back to the browser's default — lossy, but a take, which beats no take.
export const LOSSLESS_RECORD_MIMES = [
  "audio/webm;codecs=pcm",
  "audio/wav",
  "audio/x-wav",
  "audio/webm;codecs=flac",
  "audio/ogg;codecs=flac",
] as const;

/** The first lossless capture format this browser supports, or undefined to take its default. */
export function pickRecorderMime(isTypeSupported?: (t: string) => boolean): string | undefined {
  if (typeof isTypeSupported !== "function") return undefined;
  for (const m of LOSSLESS_RECORD_MIMES) {
    let ok = false;
    try {
      ok = isTypeSupported(m);
    } catch {
      ok = false; // a browser that throws on an unknown type has answered "no"
    }
    if (ok) return m;
  }
  return undefined;
}

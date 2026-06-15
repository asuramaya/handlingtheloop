import init, { fingerprint } from "./wasm/htl_fingerprint.js";
import wasmUrl from "./wasm/htl_fingerprint_bg.wasm?url";

// Chromaprint (AcoustID-compatible) fingerprint of a decoded AudioBuffer, via the
// pure-Rust rusty-chromaprint compiled to wasm. Used by the background precompute to
// identify a track's canonical recording (→ ISRC) instead of guessing from its title.

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  return (ready ??= init({ module_or_path: wasmUrl }).then(() => undefined));
}

// AcoustID matches on ~the first two minutes; no need to fingerprint a whole track.
const FP_SECONDS = 120;

/** AcoustID-format fingerprint (base64) of a buffer, or null on failure/too-short. */
export async function fingerprintBuffer(buffer: AudioBuffer): Promise<string | null> {
  try {
    await ensure();
    const sr = buffer.sampleRate;
    const frames = Math.min(buffer.length, Math.floor(sr * FP_SECONDS));
    if (frames < sr * 10) return null; // <10s — not worth identifying
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const pcm = new Int16Array(frames); // mono i16 at native rate (chromaprint resamples)
    for (let i = 0; i < frames; i++) {
      let s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      pcm[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    return fingerprint(pcm, sr, 1) ?? null;
  } catch {
    return null;
  }
}

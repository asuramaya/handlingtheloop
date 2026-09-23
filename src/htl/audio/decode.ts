// Shared decode with an actionable error message. decodeAudioData detaches its
// input, so we always hand it a copy and let callers keep the original bytes.
//
// CRUCIAL: we decode on a throwaway OfflineAudioContext, NEVER the live playback
// context, even though callers pass the live `ctx`. Decoding a track on an actively
// rendering AudioContext contends with its render graph — a big buffer decode +
// allocation lands as a micro-stutter on the *other* deck the moment you load a new
// track while one is playing. An OfflineAudioContext has no realtime render thread of
// its own, so the decode can't starve live playback. The resulting AudioBuffer is a
// plain data container (we only ever read getChannelData / copy it into the stretch
// worklet — it's never wired as a live source node), so it's safe to use on the live
// context as long as the sample rate matches — which we guarantee by building the
// decoder at `ctx.sampleRate`. One decoder is cached per sample rate.

import { armDecode, disarmDecode } from "./decodeCrashGuard";

let decoderByRate: { rate: number; ctx: OfflineAudioContext } | null = null;

function decoderFor(sampleRate: number): BaseAudioContext {
  const rate = sampleRate > 0 ? sampleRate : 44100;
  if (!decoderByRate || decoderByRate.rate !== rate) {
    // 1 frame is the minimum; we never startRendering() — the context exists only to own
    // decodeAudioData off the live audio thread.
    decoderByRate = { rate, ctx: new OfflineAudioContext(2, 1, rate) };
  }
  return decoderByRate.ctx;
}

export async function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  if (data.byteLength === 0) throw new Error("File is empty (0 bytes).");
  // ★ THE ONLY PLACE A TAB CAN DIE WITHOUT SAYING SO. decodeAudioData materialises the WHOLE
  // float32 buffer — there is no chunked form of this call — so it is the single largest transient
  // allocation in a track load, and an OOM here kills the process with no exception to catch.
  // Armed here and disarmed on both exits, so the next boot can name what was in flight.
  armDecode(data.byteLength);
  try {
    const out = await decoderFor(ctx.sampleRate).decodeAudioData(data.slice(0));
    disarmDecode();
    return out;
  } catch {
    disarmDecode(); // a THROWN decode failure is a codec problem, not a crash — do not report it as one
    throw new Error(
      "Couldn't decode this audio — the browser can't read its codec " +
        "(unsupported format, a video, or DRM-protected).",
    );
  }
}

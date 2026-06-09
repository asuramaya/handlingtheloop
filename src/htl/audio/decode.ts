// Shared decode with an actionable error message. decodeAudioData detaches its
// input, so we always hand it a copy and let callers keep the original bytes.
export async function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  if (data.byteLength === 0) throw new Error("File is empty (0 bytes).");
  try {
    return await ctx.decodeAudioData(data.slice(0));
  } catch {
    throw new Error(
      "Couldn't decode this audio — the browser can't read its codec " +
        "(unsupported format, a video, or DRM-protected).",
    );
  }
}

/// <reference lib="webworker" />
// Stem Opus decode off the main thread (task #132). The worker receives the htl-Opus blob and
// returns raw f32 planes — no AudioContext exists here, which is exactly why the decode had to be
// split from the buffer assembly (see decodeStemOpusPlanes).
//
// It does NOT slice. Slicing exists to give the MAIN thread back between chunks; here there is
// nothing to give back, and measurement showed the yield costs wall time and buys nothing off the
// main thread. Infinity is the no-sleep path through the same code.
import { decodeStemOpusPlanes } from "./opus";

interface Req {
  id: number;
  bytes: ArrayBuffer;
}

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { id, bytes } = e.data;
  try {
    const { planes, sampleRate } = await decodeStemOpusPlanes(bytes, { sliceMs: Infinity });
    ctx.postMessage(
      { id, planes, sampleRate },
      planes.map((p) => p.buffer),
    );
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};

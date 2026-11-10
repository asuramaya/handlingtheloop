/// <reference lib="webworker" />
// Stem Opus decode off the main thread (task #132). The worker receives the htl-Opus blob and
// returns raw f32 planes — no AudioContext exists here, which is exactly why the decode had to be
// split from the buffer assembly (see decodeStemOpusPlanes).
//
// `pack` requests the mobile shape instead: int16 groups + the waveform envelope, packed frame by
// frame as the decoder hands them out (decodeStemOpusPacked), so neither this worker nor the main
// thread ever holds the stem as full-length float32. Only the int16 (half a float32 copy) crosses.
//
// It does NOT slice. Slicing exists to give the MAIN thread back between chunks; here there is
// nothing to give back, and measurement showed the yield costs wall time and buys nothing off the
// main thread. Infinity is the no-sleep path through the same code (the packed decode still waits
// for its own outputs — that is backpressure, not slicing).
import { decodeStemOpusPlanes, decodeStemOpusPacked } from "./opus";

interface Req {
  id: number;
  bytes: ArrayBuffer;
  pack?: { limit?: number };
}

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { id, bytes, pack } = e.data;
  try {
    if (pack) {
      const out = await decodeStemOpusPacked(bytes, { limit: pack.limit, sliceMs: Infinity });
      const b = out.base;
      ctx.postMessage({ id, packed: out }, [
        out.L.buffer,
        out.R.buffer,
        b.min.buffer,
        b.max.buffer,
        b.low.buffer,
        b.mid.buffer,
        b.high.buffer,
      ] as ArrayBuffer[]);
      return;
    }
    const { planes, sampleRate } = await decodeStemOpusPlanes(bytes, { sliceMs: Infinity });
    ctx.postMessage(
      { id, planes, sampleRate },
      planes.map((p) => p.buffer),
    );
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};

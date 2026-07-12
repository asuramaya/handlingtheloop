import { useEffect, useRef } from "react";

// ★ THE PATTERN for every live, direct-manipulation surface in this app (the EQ curve, the delay
// timeline, the reverb dome, the XY pads). Three rules, and they're in priority order:
//
//   1. MUTATE THE AUDIO IMMEDIATELY. Sound must never wait for a frame or a React render.
//   2. PAINT THE CANVAS FROM THE VALUE YOU JUST COMPUTED — never from a React round-trip. A
//      surface that learns its own gesture second-hand is always at least a render behind its
//      own input, and stalls outright if that render is ever batched or throttled.
//   3. FOLD THE REACT RENDER + THE SESSION EMIT INTO ONE PASS PER FRAME. This hook.
//
// Why 3 matters: a pointermove fires 2–4× per frame on a 120 Hz mouse, and a trackpad can burst
// harder. Doing a full React render AND a session emit on every one of them spends the frame
// budget re-rendering the deck instead of painting the thing under your finger — the surface goes
// choppy and feels like it's fighting you — and it floods the socket with redundant intents that
// a remote device has to chew through.
//
// `push(param, value)` keeps only the LATEST value per param id and flushes on the next frame:
// one emit per param that actually moved, then one refresh. Intermediate values within a frame
// are dropped on purpose — nobody can hear or see them, and the last one is the truth.

export function useFrameSync(emitOne: (param: string, value: number) => void, refresh: () => void) {
  const pending = useRef<Record<string, number>>({});
  const raf = useRef(0);
  // Latest callbacks, so the scheduled flush never fires a stale closure.
  const fns = useRef({ emitOne, refresh });
  fns.current = { emitOne, refresh };

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  return (param: string, value: number) => {
    pending.current[param] = value;
    if (raf.current) return; // a flush is already booked for this frame
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const batch = pending.current;
      pending.current = {};
      for (const k in batch) fns.current.emitOne(k, batch[k]);
      fns.current.refresh();
    });
  };
}

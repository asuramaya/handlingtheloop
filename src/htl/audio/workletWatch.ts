import { event } from "../debug/trace";

// ★ A WORKLET THAT THROWS DOES NOT CRASH. IT GOES SILENT, FOREVER, AND SAYS NOTHING.
//
// Measured in this repo's own Chromium, not cited from the spec: a processor that throws once on
// block 10 of a 375-block render sounds for blocks 0–9 and outputs SILENCE for the remaining 365.
// `onprocessorerror` fires exactly once and is the only signal that anything happened. Nothing is
// thrown anywhere a caller can catch, the node stays connected, and every meter downstream reads a
// legitimate zero.
//
// ★ AND IT IS THE OPPOSITE OF WHAT A WORKER DOES, which is why treating them as the same word is a
// trap. Measured the same evening: a Worker that throws an uncaught error fires onerror, drops that
// one message, and answers the very NEXT message normally — it survives. A worklet does not. Same
// word, opposite consequence, and this codebase had `degraded` handling for worklets that could not
// be CONSTRUCTED and nothing at all for one that died while running.
//
// What that costs here is not hypothetical: the comp worklet is the master brickwall, so one throw
// there silences the whole output; the stretch worklet holds the deck's PCM, so one throw there
// silences that deck. The operator would hear it instantly and the console would be empty.
//
// ★ THE SPLIT BETWEEN THE TWO SINKS IS DELIBERATE, and it is tonight's unit-of-count lesson applied
// on purpose rather than discovered afterwards. The RING takes every incident, because each node is
// genuinely a separate failure and the ring is the record a bug report dumps. The CONSOLE says it
// once per KIND, because a rack rebuild can construct several nodes of one kind against the same
// broken module and that is the same silence heard again, not new information.

/** The one property this needs — structural so the rule is testable without a browser. */
export interface ProcessorErrorTarget {
  onprocessorerror: ((ev: ErrorEvent) => unknown) | null;
}

const told = new Set<string>();

/** Attach the only signal a dying worklet gives. Call it at EVERY `new AudioWorkletNode`. */
export function watchProcessor(node: ProcessorErrorTarget, kind: string, where = ""): void {
  node.onprocessorerror = () => {
    event("worklet-dead", { kind, where });
    if (told.has(kind)) return;
    told.add(kind);
    console.error(
      `[htl] the "${kind}" worklet processor threw and is now PERMANENTLY SILENT${where ? ` (${where})` : ""} — ` +
        `everything downstream of it will read a legitimate zero. This node will not recover; reload to rebuild it.`,
    );
  };
}

/** Tests only — the once-per-kind mute is module state and would leak between cases. */
export function resetWorkletWatch(): void {
  told.clear();
}

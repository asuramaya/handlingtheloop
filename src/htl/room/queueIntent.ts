import type { Intent, QueuedTrack } from "./protocol";

// APPLYING A QUEUE EDIT FROM THE WIRE — lifted out of the useCallback in useSessionSync for the
// same reason applyIntent was, and it is the same reason every time: while it sat in a closure
// inside a hook, no test could call it, so the one genuinely subtle rule in it went unexercised.
//
// ★ THAT RULE IS AN AUTHORITY RULE, and it is the whole content. Only the device running the
// auto-mixer and broadcasting the stream mutates the canonical queue; a MIRRORING remote ignores the
// intent entirely, because its local queue is unused and applying would fork a second copy that then
// diverges silently. The authority re-streams afterwards, so everyone converges 1:1 on its copy.
//
// ★ AND THE REFUSAL IS NOT A FAILURE, which is why this returns a witness rather than void. "Ignored
// because we are mirroring" and "applied" are different outcomes that look identical from outside,
// and telling them apart is exactly what a two-device test needs to assert. Nothing in the app reads
// the return today; that is deliberate — the value is that the distinction EXISTS and is checkable,
// not that a caller branches on it.
//
// The target is a narrowed structural interface declared here, the same shape IntentDeck and
// SnapshotDeck use: the real queue satisfies it by having the methods, with no import and no change
// on its side, and this module cannot reach the rest of the queue.

/** The queue surface a wire edit may touch, and nothing else. No seed, no mode, no radio fill —
 *  those are host-owned (the radio engine), and a remote moves individual tracks only. */
export interface QueueTarget {
  enqueue(t: QueuedTrack): void;
  enqueueNext(t: QueuedTrack): void;
  remove(videoId: string): void;
  moveById(videoId: string, to: number): void;
}

/** Why an edit did or did not land — the witness. */
export type QueueApply = "applied" | "mirroring" | "no-queue" | "unknown-action";

export function applyQueueIntent(
  intent: Extract<Intent, { kind: "queue" }>,
  target: QueueTarget | null | undefined,
  opts: { mirroring: boolean },
): QueueApply {
  // Order matters and it is not arbitrary: a mirroring device may also HAVE a queue, and it must
  // still refuse. Checking for the queue first would let a mirror with one apply.
  if (opts.mirroring) return "mirroring";
  if (!target) return "no-queue";
  switch (intent.action) {
    case "add":
      target.enqueue(intent.track);
      return "applied";
    case "addNext":
      target.enqueueNext(intent.track);
      return "applied";
    case "remove":
      target.remove(intent.videoId);
      return "applied";
    case "move":
      // ID-based, never index-based: the right track even when the sender's from-index was stale.
      target.moveById(intent.videoId, intent.to);
      return "applied";
    default:
      // A newer peer's action we do not know. Ignored rather than guessed — a queue edit applied
      // from a misread intent is worse than one dropped, because the authority then re-streams it.
      return "unknown-action";
  }
}

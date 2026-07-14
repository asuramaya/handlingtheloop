// The lyrics pool's convergence rules, as pure functions.
//
// WHY THIS IS ITS OWN MODULE. These two decisions are the whole reason a bad transcript either
// heals or sticks forever, and both used to be inline in resolveLyrics — which is unreachable
// from a test (it needs a Deck, a Worker, WebGPU and fetch). The equivalent extraction on the
// library re-sync caught a real bug in the reconciler the moment it had tests, so: extract the
// decision, test the decision.
//
// THE CONTRACT (the same one track_analysis uses for beatgrids):
//   Every stored transcript carries the FORMAT VERSION that produced it.
//   REUSE a stored transcript iff its version is >= ours; otherwise re-decode and UPGRADE it.
//   A write may never move a row backwards (the D1 upsert enforces that half — migration 0026).
// The result is monotone: a stale transcript is repaired by the first capable device that plays
// the track, and no device can undo the repair.

/** What to show, and whether to spend a GPU decode upgrading it. */
export interface LyricsPlan {
  /** Which stored copy to display right now (null = we have nothing yet). */
  show: "local" | "pool" | null;
  /** Re-decode on this device: we have nothing, or what we have is an older format than ours. */
  decode: boolean;
  /** The pooled row is better than our local copy → cache it locally (at ITS version, not ours). */
  adoptPool: boolean;
}

export function planLyrics(o: {
  /** Format version of the copy in the local cache, or null if we have none. */
  local: number | null;
  /** Format version of the pooled row, or null on a miss (or if we never asked). */
  pooled: number | null;
  /** This client's transcript format (LYRICS_VER). */
  clientVer: number;
  /** Can this device actually run Whisper (desktop GPU) AND is it allowed to? */
  canDecode: boolean;
}): LyricsPlan {
  const local = o.local ?? -1;
  const pooled = o.pooled ?? -1;

  // Ties go to LOCAL: an equal-version pooled row is not worth a re-write of the IndexedDB record.
  const adoptPool = o.pooled != null && pooled > local;
  const bestVer = Math.max(local, pooled);
  const show: LyricsPlan["show"] = bestVer < 0 ? null : adoptPool ? "pool" : "local";

  // Decode when we have nothing, or when the best thing we have is an OLDER format than this
  // client produces. A device that can't decode never decodes — it just keeps showing the stale
  // transcript, which beats no lyrics, until some capable device repairs the pool for it.
  const decode = o.canDecode && bestVer < o.clientVer;

  return { show, decode, adoptPool };
}

// ★ `looksDegenerate()` USED TO LIVE HERE, AND ITS DELETION IS THE POINT. It caught Whisper's
// signature failure on an instrumental — LOOPING one phrase over and over — so that a hallucinated
// transcript could never reach the shared pool. It was a guard against our own word source LYING.
//
// The words now come from a lyrics database, so they cannot be fiction: the worst this pipeline can
// produce is the RIGHT words at the WRONG times. And an instrumental is no longer something we have
// to detect from the output at all — LRCLIB simply tells us, before we do any work. A whole class of
// defensive code stops being necessary the moment the input stops being a guess.

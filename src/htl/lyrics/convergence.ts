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
import type { LyricsLine } from "./types";

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

/** Whisper's signature failure on an instrumental or near-silent stem is to LOOP — it emits the
 *  same phrase over and over (or subtitle boilerplate it learned in training). That transcript is
 *  worthless, and once contributed it is served to every other device, so it must never reach the
 *  shared pool. Judged by repetition, not by a phrase blocklist: real lyrics repeat a chorus, they
 *  do not consist ENTIRELY of one line. Short transcripts are never judged — a sparse song is
 *  legitimately a handful of lines, and a false positive here costs a real transcript. */
export function looksDegenerate(lines: LyricsLine[]): boolean {
  if (lines.length < 6) return false;
  const texts = lines.map((l) => l.text.toLowerCase().trim()).filter((t) => t.length > 0);
  if (texts.length < 6) return false;
  const distinct = new Set(texts).size;
  return distinct / texts.length < 0.25; // three quarters of it is the same handful of lines
}

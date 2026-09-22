// Who owns a deck's in-flight-load claim.
//
// A deck carries one claim (`loadingVid`) so a room snapshot or a resync tick can tell "a load for
// this track is already running" from "nothing is happening here". Every load that ends without
// landing must give the claim back — but ONLY if it is still the claim it made, or it hands a live
// successor's dedupe key to the garbage collector.
//
// ★ OWNERSHIP IS THE SEQUENCE, NEVER THE videoId. The test used to compare ids, on the reasoning
// that a different id in the slot proved a newer load had taken over. That reasoning holds only
// when a successor loads a DIFFERENT track, and the path that matters most reloads the SAME one:
// the follower's tick-resync re-requests the anchor's track. So a superseded load released the
// claim its own successor was holding, the next tick read "nothing loading this vid", started
// another load, aborted the one running, and the new predecessor wiped the claim again — a deck
// that reloaded every ~3 s forever, never landing, in complete silence (ruling ab419a94).
export interface ClaimRelease {
  landed: boolean; //     the track reached the deck → the claim stays as the dedupe key
  claimedVid: string; //  the id this load claimed ("" = it never got as far as claiming)
  claimSeq: number; //    the sequence currently holding the deck's claim
  mySeq: number; //       this load's sequence
}

/** True when this load should hand the deck's claim back. */
export function shouldReleaseClaim(p: ClaimRelease): boolean {
  if (p.landed || !p.claimedVid) return false;
  return p.claimSeq === p.mySeq;
}

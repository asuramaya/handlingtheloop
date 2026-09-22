import { describe, test, expect } from "vitest";
import { shouldReleaseClaim } from "./loadClaim";

const VID = "QJbPvDz0NTo";

describe("shouldReleaseClaim", () => {
  test("a load that landed keeps the claim — it IS the dedupe key", () => {
    expect(shouldReleaseClaim({ landed: true, claimedVid: VID, claimSeq: 2, mySeq: 2 })).toBe(false);
  });

  test("a load that never claimed has nothing to give back", () => {
    expect(shouldReleaseClaim({ landed: false, claimedVid: "", claimSeq: 3, mySeq: 2 })).toBe(false);
  });

  test("the owner releases, so a successor that died before claiming strands nothing", () => {
    expect(shouldReleaseClaim({ landed: false, claimedVid: VID, claimSeq: 2, mySeq: 2 })).toBe(true);
  });

  test("★ a SUPERSEDED load does not disarm its live successor — even reloading the SAME track", () => {
    // seq 3 claimed the same videoId seq 2 had; seq 2 now ends stale. Comparing ids would clear the
    // slot here, which is exactly the livelock: the next resync tick would see nothing loading.
    expect(shouldReleaseClaim({ landed: false, claimedVid: VID, claimSeq: 3, mySeq: 2 })).toBe(false);
  });

  test("the resync livelock cannot re-form: across a chain of same-track loads the claim is never empty", () => {
    // Replays the observed trace: each resync starts a new load for the same vid, the previous one
    // ends stale a moment later. The deck must look BUSY throughout, or the next tick reloads again.
    let claimSeq = 0;
    let claim = "";
    const start = (seq: number) => {
      claim = VID;
      claimSeq = seq;
    };
    const endStale = (seq: number) => {
      if (shouldReleaseClaim({ landed: false, claimedVid: VID, claimSeq, mySeq: seq })) claim = "";
    };
    start(2);
    start(3); // resync supersedes before seq 2 finishes
    endStale(2);
    expect(claim).toBe(VID); // seq 3 is still running — the deck is busy
    start(4);
    endStale(3);
    expect(claim).toBe(VID);
    endStale(4); // the last one gives up for real
    expect(claim).toBe("");
  });
});

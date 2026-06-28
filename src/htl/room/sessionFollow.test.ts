import { describe, it, expect } from "vitest";
import {
  decideFollowTick,
  decideSnapshotDeck,
  decideStemConverge,
  shouldStartOnDecode,
  BEHIND_THRESHOLD,
  SEEK_GRACE_MS,
  PAUSED_ALIGN_DRIFT,
  FLIP_SEEK_DRIFT,
  TICK_DRIVING_MS,
  STEM_TOUCH_GRACE_MS,
  type FollowTickInput,
  type StemConvergeInput,
} from "./sessionFollow";

// The follower's drift-correction core. These cases lock the exact thresholds and the hard-won
// invariant that a steady-playing follower is only ever pulled FORWARD (never seeked backward to a
// stale tick), which is what killed the "loops a second forever, never catches up" bug.
describe("decideFollowTick", () => {
  const base: FollowTickInput = {
    masterPlaying: true,
    deckPlaying: true,
    deckPos: 10,
    masterPos: 10,
    sinceFollowSeekMs: 5000, // well past the grace window
  };

  describe("transport flips", () => {
    it("starts a paused follower when the master is playing (seek-first only if drifted)", () => {
      expect(decideFollowTick({ ...base, masterPlaying: true, deckPlaying: false, deckPos: 10, masterPos: 10 })).toEqual({ kind: "start", seek: false });
      // drifted past the flip threshold → seek before the source starts (clean catch-up)
      expect(decideFollowTick({ ...base, masterPlaying: true, deckPlaying: false, deckPos: 10, masterPos: 30 })).toEqual({ kind: "start", seek: true });
    });

    it("stops a playing follower when the master pauses (land on the master pos if drifted)", () => {
      expect(decideFollowTick({ ...base, masterPlaying: false, deckPlaying: true, deckPos: 20, masterPos: 20 })).toEqual({ kind: "stop", seek: false });
      expect(decideFollowTick({ ...base, masterPlaying: false, deckPlaying: true, deckPos: 20, masterPos: 5 })).toEqual({ kind: "stop", seek: true });
    });

    it("the flip seek threshold is exactly FLIP_SEEK_DRIFT (strictly greater)", () => {
      // deckPos 0 so drift === masterPos exactly (no float drift from a large-base subtraction).
      const atThreshold = decideFollowTick({ ...base, masterPlaying: true, deckPlaying: false, deckPos: 0, masterPos: FLIP_SEEK_DRIFT });
      const justOver = decideFollowTick({ ...base, masterPlaying: true, deckPlaying: false, deckPos: 0, masterPos: FLIP_SEEK_DRIFT * 2 });
      expect(atThreshold).toEqual({ kind: "start", seek: false }); // == threshold → no seek
      expect(justOver).toEqual({ kind: "start", seek: true });
    });
  });

  describe("steady playback — only ever pull FORWARD (the loop-forever bug)", () => {
    it("holds when in sync", () => {
      expect(decideFollowTick({ ...base, deckPos: 10, masterPos: 10 })).toEqual({ kind: "hold" });
    });

    it("NEVER seeks backward when the follower leads the stale tick (network latency / frozen master clock)", () => {
      // We're 5s AHEAD of the tick — a backward seek here is the bug. Must hold.
      expect(decideFollowTick({ ...base, deckPos: 15, masterPos: 10 })).toEqual({ kind: "hold" });
      // Even a large lead holds.
      expect(decideFollowTick({ ...base, deckPos: 100, masterPos: 10 })).toEqual({ kind: "hold" });
    });

    it("holds a small lag within the behind threshold", () => {
      expect(decideFollowTick({ ...base, deckPos: 10, masterPos: 10 + BEHIND_THRESHOLD - 0.01 })).toEqual({ kind: "hold" });
    });

    it("catches up only when behind past BEHIND_THRESHOLD", () => {
      expect(decideFollowTick({ ...base, deckPos: 10, masterPos: 10 + BEHIND_THRESHOLD + 0.01 })).toEqual({ kind: "catchup" });
      // exactly at threshold → not yet (strictly greater)
      expect(decideFollowTick({ ...base, deckPos: 10, masterPos: 10 + BEHIND_THRESHOLD })).toEqual({ kind: "hold" });
    });

    it("respects the grace window — no back-to-back catch-ups", () => {
      const behind = { ...base, deckPos: 10, masterPos: 12 }; // 2s behind, well over threshold
      expect(decideFollowTick({ ...behind, sinceFollowSeekMs: SEEK_GRACE_MS + 1 })).toEqual({ kind: "catchup" });
      expect(decideFollowTick({ ...behind, sinceFollowSeekMs: SEEK_GRACE_MS })).toEqual({ kind: "hold" }); // == grace → wait
      expect(decideFollowTick({ ...behind, sinceFollowSeekMs: 0 })).toEqual({ kind: "hold" });
    });
  });

  describe("both paused — silent align", () => {
    it("aligns tightly past PAUSED_ALIGN_DRIFT (a paused seek is silent)", () => {
      const paused = { ...base, masterPlaying: false, deckPlaying: false };
      expect(decideFollowTick({ ...paused, deckPos: 10, masterPos: 10 + PAUSED_ALIGN_DRIFT + 0.01 })).toEqual({ kind: "align" });
      expect(decideFollowTick({ ...paused, deckPos: 10, masterPos: 10 + PAUSED_ALIGN_DRIFT })).toEqual({ kind: "hold" }); // == threshold → hold
      expect(decideFollowTick({ ...paused, deckPos: 10, masterPos: 10.01 })).toEqual({ kind: "hold" });
    });

    it("aligns backward too (paused → no audible skip either way)", () => {
      const paused = { ...base, masterPlaying: false, deckPlaying: false };
      expect(decideFollowTick({ ...paused, deckPos: 30, masterPos: 10 })).toEqual({ kind: "align" });
    });
  });
});

// The snapshot deck dispatch + its two dedupe guards: load-once (a duplicate snapshot can't load the
// same track twice) and reconcile-once (a republished snapshot can't stomp a controller's live edits).
describe("decideSnapshotDeck", () => {
  const empty = { snapVideoId: null, loadedId: null, roomLoadTarget: null, loadingVid: "", reconciledTarget: null };

  it("skips an empty deck", () => {
    expect(decideSnapshotDeck(empty)).toBe("skip");
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "" })).toBe("skip");
  });

  it("loads a genuinely new track", () => {
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "new1" })).toBe("load");
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "new1", loadedId: "old0" })).toBe("load");
  });

  it("load dedupe — does NOT re-load a track already loaded / loading / targeted", () => {
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "v", loadedId: "v" })).not.toBe("load");
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "v", roomLoadTarget: "v" })).toBe("skip");
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "v", loadingVid: "v" })).toBe("skip");
  });

  it("reconciles a loaded-but-unreconciled track exactly once", () => {
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "v", loadedId: "v", reconciledTarget: null })).toBe("reconcile");
    // already reconciled → skip (don't stomp live edits)
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "v", loadedId: "v", reconciledTarget: "v" })).toBe("skip");
  });

  it("a track loading (not yet decoded) is neither loaded again nor reconciled yet", () => {
    // targeted + decoding, not yet in loadedId → skip until the decode lands
    expect(decideSnapshotDeck({ ...empty, snapVideoId: "v", roomLoadTarget: "v", loadingVid: "v" })).toBe("skip");
  });
});

// The post-decode join fallback: start a freshly-decoded follower from the snapshot transport, but
// defer to the tick when the anchor is actively driving this deck (else the audible skip on join).
describe("shouldStartOnDecode", () => {
  it("starts a decoded-but-paused follower when the snapshot says playing and no tick is driving", () => {
    expect(shouldStartOnDecode({ snapPlaying: true, deckPlaying: false, sinceLastTickMs: TICK_DRIVING_MS + 1 })).toBe(true);
  });

  it("does NOT start when the anchor is actively ticking this deck (let the tick start it fresh)", () => {
    expect(shouldStartOnDecode({ snapPlaying: true, deckPlaying: false, sinceLastTickMs: TICK_DRIVING_MS - 1 })).toBe(false);
    expect(shouldStartOnDecode({ snapPlaying: true, deckPlaying: false, sinceLastTickMs: 0 })).toBe(false);
  });

  it("does nothing when the snapshot is paused or the deck already plays", () => {
    expect(shouldStartOnDecode({ snapPlaying: false, deckPlaying: false, sinceLastTickMs: 99999 })).toBe(false);
    expect(shouldStartOnDecode({ snapPlaying: true, deckPlaying: true, sinceLastTickMs: 99999 })).toBe(false);
  });
});

// Per-stem convergence on a tick: idempotent (only flip what moved), with the 400 ms self-touch
// grace, and the active===muted mute-disagreement encoding.
describe("decideStemConverge", () => {
  const settled: StemConvergeInput = { sinceTouchMs: 5000, masterGain: 0.8, masterMuted: false, localLevel: 0.8, localActive: true };

  it("leaves a freshly self-touched stem entirely alone (the grace window)", () => {
    const divergent = { ...settled, masterGain: 0.2, masterMuted: true }; // both would otherwise move
    expect(decideStemConverge({ ...divergent, sinceTouchMs: STEM_TOUCH_GRACE_MS - 1 })).toEqual({ setGain: false, setMute: false });
    // == grace boundary → no longer protected (strictly less-than guards it)
    expect(decideStemConverge({ ...divergent, sinceTouchMs: STEM_TOUCH_GRACE_MS })).toEqual({ setGain: true, setMute: true });
  });

  it("is idempotent — no writes when already converged", () => {
    expect(decideStemConverge(settled)).toEqual({ setGain: false, setMute: false });
  });

  it("sets the gain only when it differs and the anchor sent one", () => {
    expect(decideStemConverge({ ...settled, masterGain: 0.3, localLevel: 0.8 }).setGain).toBe(true);
    expect(decideStemConverge({ ...settled, masterGain: 0.8, localLevel: 0.8 }).setGain).toBe(false);
    // anchor omitted the gain on this tick → never touch it
    expect(decideStemConverge({ ...settled, masterGain: null, localLevel: 0.8 }).setGain).toBe(false);
    expect(decideStemConverge({ ...settled, masterGain: undefined, localLevel: 0.8 }).setGain).toBe(false);
    // a 0 gain is a real value, not "absent" — must converge
    expect(decideStemConverge({ ...settled, masterGain: 0, localLevel: 0.8 }).setGain).toBe(true);
  });

  it("flips mute exactly when our audible-state disagrees with the anchor's want", () => {
    // audible (active) but anchor wants muted → mute
    expect(decideStemConverge({ ...settled, localActive: true, masterMuted: true }).setMute).toBe(true);
    // muted but anchor wants audible → unmute
    expect(decideStemConverge({ ...settled, localActive: false, masterMuted: false }).setMute).toBe(true);
    // already agree → no flip
    expect(decideStemConverge({ ...settled, localActive: true, masterMuted: false }).setMute).toBe(false);
    expect(decideStemConverge({ ...settled, localActive: false, masterMuted: true }).setMute).toBe(false);
  });
});

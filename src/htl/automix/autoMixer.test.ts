import { describe, test, expect } from "vitest";
// autoMixer.ts imports cleanly in a plain-node test env (no AudioContext/DOM is
// touched at module load — the engine is only reached through the injected deps),
// so its pure module-level helpers can be unit-tested directly.
import { barsToSeconds, decideLive, other, radioSeedSet } from "./autoMixer";
import type { TrackMeta } from "../library/types";

const track = (videoId: string): TrackMeta => ({ videoId, title: videoId, artist: "", duration: 0, thumbnail: null, views: null });

describe("barsToSeconds", () => {
  // 4 bars * 4 beats/bar * 60s / bpm. At 120bpm: 16 beats * 0.5s = 8s.
  test("4 bars @ 120bpm = 8s", () => {
    expect(barsToSeconds(4, 120)).toBeCloseTo(8, 10);
  });

  test("12 bars @ 120bpm = 24s (the armed-phase default lead window)", () => {
    expect(barsToSeconds(12, 120)).toBeCloseTo(24, 10);
  });

  test("1 bar @ 60bpm = 4s (one beat per second, 4 beats)", () => {
    expect(barsToSeconds(1, 60)).toBeCloseTo(4, 10);
  });

  test("scales inversely with bpm: doubling bpm halves the seconds", () => {
    expect(barsToSeconds(8, 174)).toBeCloseTo(barsToSeconds(8, 87) / 2, 10);
  });

  // Invalid/zero/negative bpm → fallback of `bars * 2` seconds (a neutral 120bpm-ish
  // guess so the mixer never divides by zero or produces NaN/Infinity).
  test("bpm = 0 → fallback bars*2", () => {
    expect(barsToSeconds(4, 0)).toBe(8);
  });

  test("negative bpm → fallback bars*2", () => {
    expect(barsToSeconds(6, -120)).toBe(12);
  });

  test("NaN bpm → fallback bars*2 (NaN is falsy under the `!bpm` guard? no — guard uses bpm<=0)", () => {
    // NOTE: the guard is `if (!bpm || bpm <= 0)`. NaN is truthy-falsy: `!NaN === true`,
    // so NaN hits the fallback branch and returns bars*2. Documented, not a bug.
    expect(barsToSeconds(3, NaN)).toBe(6);
  });
});

describe("other", () => {
  test("A → B", () => {
    expect(other("A")).toBe("B");
  });

  test("B → A", () => {
    expect(other("B")).toBe("A");
  });

  test("is an involution: other(other(x)) === x", () => {
    expect(other(other("A"))).toBe("A");
    expect(other(other("B"))).toBe("B");
  });
});

// The death-spiral guard: the radio seed set must NEVER include the idle deck when it holds our own
// eager-preload (or the queue's own next), or the deck-seed signature flips every tick → cooldown
// bypass → refetch → tail-replace → reload → forever. The stability property is the real assertion.
const A = track("Atrack0001"), B = track("Btrack0002"), C = track("Ctrack0003");
describe("radioSeedSet — the fedBack spiral guard", () => {
  test("normal case: live + anchor + a genuinely user-loaded other deck", () => {
    const seeds = radioSeedSet({ live: A, anchor: A, idleTrack: B, preloadedIsIdle: false, queueNextId: "Ztrack0099" });
    expect(seeds.map((s) => s.videoId)).toEqual(["Atrack0001", "Btrack0002"]); // live==anchor deduped
  });

  test("EXCLUDES the idle deck when it holds our eager-preload (preloadedIsIdle)", () => {
    const seeds = radioSeedSet({ live: A, anchor: A, idleTrack: B, preloadedIsIdle: true, queueNextId: null });
    expect(seeds.map((s) => s.videoId)).toEqual(["Atrack0001"]); // B (the preload) is NOT a seed
  });

  test("EXCLUDES the idle deck when it merely holds the queue's own next track", () => {
    const seeds = radioSeedSet({ live: A, anchor: A, idleTrack: B, preloadedIsIdle: false, queueNextId: "Btrack0002" });
    expect(seeds.map((s) => s.videoId)).toEqual(["Atrack0001"]);
  });

  test("STABILITY: as the idle deck cycles through preloaded tracks, the seed set never changes", () => {
    // This is the property the spiral violated — the seed signature must stay put while only the
    // idle deck's preload churns, so seedChanged never fires and the cooldown holds.
    const sig = (idle: TrackMeta) => radioSeedSet({ live: A, anchor: A, idleTrack: idle, preloadedIsIdle: true, queueNextId: null }).map((s) => s.videoId).join(",");
    expect(sig(B)).toBe(sig(C)); // idle B vs idle C → same seeds ("Atrack0001")
    expect(sig(B)).toBe("Atrack0001");
  });

  test("a distinct anchor (vibe) is kept alongside the live deck", () => {
    const seeds = radioSeedSet({ live: A, anchor: C, idleTrack: B, preloadedIsIdle: true, queueNextId: null });
    expect(seeds.map((s) => s.videoId)).toEqual(["Atrack0001", "Ctrack0003"]); // idle B excluded, anchor C kept
  });

  test("dedupes and drops empties", () => {
    expect(radioSeedSet({ live: null, anchor: null, idleTrack: null, preloadedIsIdle: false, queueNextId: null })).toEqual([]);
    const seeds = radioSeedSet({ live: A, anchor: A, idleTrack: A, preloadedIsIdle: false, queueNextId: null });
    expect(seeds.map((s) => s.videoId)).toEqual(["Atrack0001"]); // all the same track → one seed
  });
});

// The stale-liveId stall: "deck B plays but it thinks A is live, stalls till A ends". decideLive
// must ALWAYS resolve to a deck the user is actually hearing, and when the user starts a second
// deck under the mixer it must FOLLOW the just-started one — not cling to the old liveId.
describe("decideLive — which deck is the user actually hearing", () => {
  test("nothing playing → null (caller decides end-vs-pause)", () => {
    expect(decideLive({ aPlay: false, bPlay: false, aPlayPrev: false, bPlayPrev: false, liveId: "A" })).toBeNull();
  });

  test("only A playing → A", () => {
    expect(decideLive({ aPlay: true, bPlay: false, aPlayPrev: true, bPlayPrev: false, liveId: "A" })).toBe("A");
  });

  test("only B playing → B (even when liveId still says A — the stall bug's recovery)", () => {
    expect(decideLive({ aPlay: false, bPlay: true, aPlayPrev: false, bPlayPrev: true, liveId: "A" })).toBe("B");
  });

  test("THE FIX: armed on A, user starts B → both play, B just rose → follow B", () => {
    // Previous tick only A played; now both play because the user dropped a track on B.
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: true, bPlayPrev: false, liveId: "A" })).toBe("B");
  });

  test("symmetric: live on B, user starts A → follow A", () => {
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: false, bPlayPrev: true, liveId: "B" })).toBe("A");
  });

  test("steady manual blend (both already playing, no new start) → keep the live deck", () => {
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: true, bPlayPrev: true, liveId: "B" })).toBe("B");
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: true, bPlayPrev: true, liveId: "A" })).toBe("A");
  });

  test("both rose together (rare) → keep live if valid, else default A", () => {
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: false, bPlayPrev: false, liveId: "B" })).toBe("B");
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: false, bPlayPrev: false, liveId: null })).toBe("A");
  });

  test("result is always a deck that is actually playing", () => {
    // Property: for every combination where something plays, the chosen deck is one that plays.
    for (const aPlay of [true, false]) {
      for (const bPlay of [true, false]) {
        if (!aPlay && !bPlay) continue;
        for (const aPlayPrev of [true, false]) {
          for (const bPlayPrev of [true, false]) {
            for (const liveId of ["A", "B", null] as const) {
              const r = decideLive({ aPlay, bPlay, aPlayPrev, bPlayPrev, liveId });
              expect(r === "A" ? aPlay : bPlay).toBe(true);
            }
          }
        }
      }
    }
  });
});

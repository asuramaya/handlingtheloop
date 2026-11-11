// The follower's half of the session sync audit (operator, 2026-11-11): loops in the timed follow,
// the trim's lifetime, the smoothed error, tick age, the local-transport grace, the loop self-heal,
// and the resync in-flight age of a parked load.
import { beforeEach, describe, expect, it } from "vitest";
import {
  decideLoopHeal,
  decideTickResync,
  decideTimedFollow,
  foldIntoLoop,
  followTrimFor,
  inFlightAgeMs,
  inLocalTransportGrace,
  loopDelta,
  sameActiveLoop,
  smoothFollowErr,
  timedFollowError,
  timedTickAge,
  transportGraceMs,
  LOOP_LOCAL_GRACE_MS,
  RESYNC_STUCK_MS,
  TIMED_SEEK_ERR,
  TIMED_TRIM_MAX,
  TRANSPORT_GRACE_MAX_MS,
  type FollowErrState,
} from "./sessionFollow";
import { isRemoteLoopApply, noteLocalIntent, resetLocalGestures, sinceLocalLoopMs, sinceLocalTransportMs, withRemoteLoopApply } from "./localGestures";

const loop = { s: 10, e: 12 }; // a 2 s loop
const base = { masterPlaying: true, deckPlaying: true, deckLatency: 0.05, sinceFollowSeekMs: 5000, loop, deckInLoop: true };

describe("timed follow inside a loop — a looping host is a point on a circle", () => {
  it("folds the host's extrapolated position into the loop (masterNow ran past the end)", () => {
    expect(foldIntoLoop(12.5, loop)).toBeCloseTo(10.5, 9);
    expect(foldIntoLoop(15.2, loop)).toBeCloseTo(11.2, 9);
    expect(foldIntoLoop(11, loop)).toBe(11);
  });
  it("a latency-shifted pos just BEFORE loop.start is the loop's tail, not a point the host plays", () => {
    expect(foldIntoLoop(9.95, loop)).toBeCloseTo(11.95, 9);
    // …but well before the start it is genuine pre-loop play (approaching the loop)
    expect(foldIntoLoop(8, loop)).toBe(8);
  });
  it("the error is the short way round: host wrapped AHEAD of us (we are just before the end)", () => {
    // host now at 12.02 → 10.02 (wrapped); +latency → 10.07; we are at 12 - 0.01 → behind by 0.08... the short way
    const r = timedFollowError({ ...base, masterNow: 12.02, deckPos: 11.99 });
    expect(r.target).toBeCloseTo(10.07, 9);
    expect(r.err).toBeCloseTo(-0.08, 9);
    const a = decideTimedFollow({ ...base, masterNow: 12.02, deckPos: 11.99 });
    expect(a.kind).toBe("trim"); // a small lag, glided — not a loop-length seek
  });
  it("the error is the short way round: we wrapped and the host has not yet (we are AHEAD)", () => {
    const r = timedFollowError({ ...base, masterNow: 11.9, deckPos: 10.0 }); // target 11.95, we are 0.05 past the wrap
    expect(r.err).toBeCloseTo(0.05, 9);
    const a = decideTimedFollow({ ...base, masterNow: 11.9, deckPos: 10.0 });
    expect(a.kind).toBe("trim");
    if (a.kind === "trim") expect(a.trim).toBeCloseTo(-0.015, 9); // slow down a little, no seek
  });
  it("a pre-loop tick pos (host wrapped, minus latency) lands inside the loop", () => {
    const r = timedFollowError({ ...base, masterNow: 9.98, deckLatency: 0, deckPos: 11.98 });
    expect(r.target).toBeCloseTo(11.98, 9);
    expect(Math.abs(r.err)).toBeLessThan(1e-9);
  });
  it("without the shared loop the plain difference stands (and a seek lands IN the loop)", () => {
    const a = decideTimedFollow({ ...base, deckInLoop: false, masterNow: 12.5, deckPos: 30 });
    expect(a.kind).toBe("seek");
    if (a.kind === "seek") expect(a.target).toBeCloseTo(10.55, 9);
  });
  it("loopDelta: shortest signed distance modulo the loop length", () => {
    expect(loopDelta(11.9, 10.1, loop)).toBeCloseTo(-0.2, 9);
    expect(loopDelta(10.1, 11.9, loop)).toBeCloseTo(0.2, 9);
    expect(loopDelta(11, 10, null)).toBe(1);
  });
});

describe("the follow trim is a per-tick output", () => {
  it("only the timed trim keeps a trim; every other action (and no timed action at all) zeroes it", () => {
    expect(followTrimFor({ kind: "trim", trim: 0.01 })).toBe(0.01);
    expect(followTrimFor({ kind: "hold" })).toBe(0);
    expect(followTrimFor({ kind: "seek", target: 1 })).toBe(0);
    expect(followTrimFor({ kind: "start", target: 1 })).toBe(0);
    expect(followTrimFor({ kind: "stop", target: 1 })).toBe(0);
    expect(followTrimFor({ kind: "align", target: 1 })).toBe(0);
    expect(followTrimFor(null)).toBe(0); // untimed / diverged / scrubbing / missing tick
  });
});

describe("the smoothed follow error", () => {
  const prev: FollowErrState = { err: 0.02, vid: "v", at: 1000 };
  it("blends small errors", () => {
    expect(smoothFollowErr(prev, 0.04, { vid: "v", now: 1250, deckPlaying: true })?.err).toBeCloseTo(0.026, 9);
  });
  it("a jump-sized error (wrap, seek) never enters the trim's average", () => {
    expect(smoothFollowErr(prev, TIMED_SEEK_ERR + 0.5, { vid: "v", now: 1250, deckPlaying: true })).toBeNull();
  });
  it("starts over on a new track, after a gap (role change / reconnect), or while paused", () => {
    expect(smoothFollowErr(prev, 0.04, { vid: "w", now: 1250, deckPlaying: true })?.err).toBe(0.04);
    expect(smoothFollowErr(prev, 0.04, { vid: "v", now: 5000, deckPlaying: true })?.err).toBe(0.04);
    expect(smoothFollowErr(prev, 0.04, { vid: "v", now: 1250, deckPlaying: false })?.err).toBe(0.04);
  });
  it("after a wrap the trim is NOT pinned at its ceiling (the old smoothing absorbed the loop length)", () => {
    // The old code averaged a ~loop-length raw error in; the next small tick still read ±1.5 %.
    let s: FollowErrState | null = { err: 0, vid: "v", at: 0 };
    s = smoothFollowErr(s, 1.9, { vid: "v", now: 250, deckPlaying: true }); // the wrap
    s = smoothFollowErr(s, 0.002, { vid: "v", now: 500, deckPlaying: true });
    const a = decideTimedFollow({ masterPlaying: true, deckPlaying: true, masterNow: 60, deckPos: 60.052, deckLatency: 0.05, sinceFollowSeekMs: 5000, smoothErr: s?.err });
    expect(a).toEqual({ kind: "trim", trim: 0 });
    expect(TIMED_TRIM_MAX).toBeGreaterThan(0);
  });
});

describe("tick age from the room clock", () => {
  it("a sane age is used (and tiny negative jitter is 0)", () => {
    expect(timedTickAge(10_100, 10_000)).toBeCloseTo(0.1, 9);
    expect(timedTickAge(9_900, 10_000)).toBe(0);
  });
  it("outside the window (clock wrong after sleep / route change) the tick is UNTIMED, not clamped", () => {
    expect(timedTickAge(14_000, 10_000)).toBeNull();
    expect(timedTickAge(9_000, 10_000)).toBeNull();
    expect(timedTickAge(null, 10_000)).toBeNull();
    expect(timedTickAge(10_000, undefined)).toBeNull();
  });
});

describe("a local transport gesture holds start / stop / seek for about a round trip", () => {
  it("grace = rtt + 150 ms, capped", () => {
    expect(transportGraceMs(100)).toBe(250);
    expect(transportGraceMs(null)).toBe(300);
    expect(transportGraceMs(2000)).toBe(TRANSPORT_GRACE_MAX_MS);
    expect(inLocalTransportGrace(200, 100)).toBe(true);
    expect(inLocalTransportGrace(260, 100)).toBe(false);
    expect(inLocalTransportGrace(null, 100)).toBe(false);
  });
});

describe("loop self-heal from the tick", () => {
  const local = { start: 10, end: 12, active: true };
  it("adopts the host's region when ours is missing, inactive or different", () => {
    expect(decideLoopHeal({ tickLoop: loop, local: null, sinceLocalLoopMs: null })).toEqual({ kind: "apply", s: 10, e: 12 });
    expect(decideLoopHeal({ tickLoop: loop, local: { ...local, active: false }, sinceLocalLoopMs: null }).kind).toBe("apply");
    expect(decideLoopHeal({ tickLoop: loop, local: { ...local, end: 12.5 }, sinceLocalLoopMs: null }).kind).toBe("apply");
    expect(decideLoopHeal({ tickLoop: loop, local: { ...local, end: 12.005 }, sinceLocalLoopMs: null }).kind).toBe("none"); // within eps
  });
  it("leaves a loop the host has left; an older anchor (undefined) never heals", () => {
    expect(decideLoopHeal({ tickLoop: null, local, sinceLocalLoopMs: null })).toEqual({ kind: "exit" });
    expect(decideLoopHeal({ tickLoop: null, local: null, sinceLocalLoopMs: null })).toEqual({ kind: "none" });
    expect(decideLoopHeal({ tickLoop: undefined, local, sinceLocalLoopMs: null })).toEqual({ kind: "none" });
  });
  it("never fights this device's own loop gesture in progress", () => {
    expect(decideLoopHeal({ tickLoop: null, local, sinceLocalLoopMs: LOOP_LOCAL_GRACE_MS - 1 })).toEqual({ kind: "none" });
    expect(decideLoopHeal({ tickLoop: null, local, sinceLocalLoopMs: LOOP_LOCAL_GRACE_MS })).toEqual({ kind: "exit" });
  });
  it("sameActiveLoop gates the modular error", () => {
    expect(sameActiveLoop(loop, local)).toBe(true);
    expect(sameActiveLoop(loop, { ...local, active: false })).toBe(false);
    expect(sameActiveLoop(null, local)).toBe(false);
  });
});

describe("localGestures — what this device did, and the remote-apply guard", () => {
  beforeEach(() => resetLocalGestures());
  it("records transport and loop gestures per deck from the emit path", () => {
    noteLocalIntent({ kind: "transport", deck: "A", action: "play" }, 1000);
    noteLocalIntent({ kind: "loopBounds", deck: "B", start: 1, end: 2, active: true }, 2000);
    noteLocalIntent({ kind: "control", deck: "A", param: "tempo", value: 1 }, 3000);
    expect(sinceLocalTransportMs("A", 1100)).toBe(100);
    expect(sinceLocalTransportMs("B", 1100)).toBeNull();
    expect(sinceLocalLoopMs("B", 2500)).toBe(500);
    expect(sinceLocalLoopMs("A", 2500)).toBeNull();
  });
  it("a loop applied from the tick is flagged remote while it runs (no broadcast)", () => {
    let seen = false;
    withRemoteLoopApply(() => (seen = isRemoteLoopApply()));
    expect(seen).toBe(true);
    expect(isRemoteLoopApply()).toBe(false);
  });
});

describe("resync in-flight age — a load parked for a muted passenger is not stuck", () => {
  it("a deferred load reports 0, so the resync waits instead of force-loading at 4 Hz", () => {
    const age = inFlightAgeMs({ loadingThis: true, deferred: true, now: 100_000, since: 1_000 });
    expect(age).toBe(0);
    expect(decideTickResync({ tickVid: "anchorVid01", loadedId: "old", inFlightForMs: age, sinceResyncMs: 99_999, attempts: 3 })).toBe("wait");
  });
  it("a live load is measured from its own last sign of life; none in flight is null", () => {
    expect(inFlightAgeMs({ loadingThis: true, deferred: false, now: 100_000, since: 80_000 })).toBe(20_000);
    expect(decideTickResync({ tickVid: "anchorVid01", loadedId: "old", inFlightForMs: 20_000, sinceResyncMs: 0, attempts: 0 })).toBe("force-load");
    expect(inFlightAgeMs({ loadingThis: true, deferred: false, now: 100_000, since: 0 })).toBe(0);
    expect(inFlightAgeMs({ loadingThis: false, deferred: false, now: 100_000, since: 1 })).toBeNull();
    expect(RESYNC_STUCK_MS).toBeLessThan(20_000);
  });
});

// The host's voice for one stem request. Every case here guards a failure that looks HEALTHY on the
// host and surfaces only on the requester, as "the session host stopped reporting progress" while the
// host is working normally. So the assertions are about FRAMES SENT over time, driven by a fake clock.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startStemRequestReporter, type StemRequestReporterDeps } from "./stemRequestReporter";
import type { StemAckState } from "./protocol";

const BEAT = 15_000;
type Frame = { state: StemAckState; reason?: string; pct?: number };

function harness(over: Partial<StemRequestReporterDeps> = {}) {
  const frames: Frame[] = [];
  let authority = true;
  let loadCb: ((p: number) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    loadCb = null;
  });
  const phases: Frame[] = [];
  const r = startStemRequestReporter({
    ack: (state, reason, pct) => frames.push({ state, ...(reason ? { reason } : {}), ...(pct !== undefined ? { pct } : {}) }),
    isAuthority: () => authority,
    subscribeLoading: (cb) => {
      loadCb = cb;
      return unsubscribe;
    },
    onPhase: (state, pct) => phases.push({ state, ...(pct !== undefined ? { pct } : {}) }),
    heartbeatMs: BEAT,
    step: 10,
    ...over,
  });
  return {
    r,
    frames,
    phases,
    unsubscribe,
    load: (p: number) => loadCb?.(p),
    loseAnchor: () => {
      authority = false;
    },
  };
}

describe("stem request reporter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens QUEUED — accepted, nothing produced yet", () => {
    const h = harness();
    expect(h.frames).toEqual([{ state: "queued" }]);
    h.r.stop();
  });

  it("a queued host with NO progress of its own keeps the requester alive — one frame per beat", () => {
    // The bug this exists for: waiting behind other GPU work produces no progress, the requester's
    // 60 s stall watchdog fires, and it reports a healthy host as stopped. Four beats per stall window.
    const h = harness();
    vi.advanceTimersByTime(BEAT * 4);
    expect(h.frames).toEqual([{ state: "queued" }, { state: "queued" }, { state: "queued" }, { state: "queued" }, { state: "queued" }]);
    h.r.stop();
  });

  it("a beat re-sends the LAST PERCENTAGE, so the requester's 40% does not flicker away between steps", () => {
    const h = harness();
    h.r.report({ kind: "progress", pct: 40 });
    vi.advanceTimersByTime(BEAT);
    expect(h.frames.at(-1)).toEqual({ state: "separating", pct: 40 });
    h.r.stop();
  });

  it("progress is step-gated; the beat is NOT — within one step only beats are sent", () => {
    const h = harness();
    h.r.report({ kind: "progress", pct: 41 });
    h.r.report({ kind: "progress", pct: 44 }); // same step → nothing
    h.r.report({ kind: "progress", pct: 49 }); // same step → nothing
    expect(h.frames).toEqual([{ state: "queued" }, { state: "separating", pct: 40 }]);
    vi.advanceTimersByTime(BEAT * 2);
    expect(h.frames.slice(2)).toEqual([{ state: "separating", pct: 40 }, { state: "separating", pct: 40 }]);
    h.r.stop();
  });

  it("walks queued → loading → separating, with a SEPARATE gate per phase", () => {
    // A shared gate would let the finished download (100) swallow separation starting again at 0.
    const h = harness();
    h.load(0);
    h.load(100);
    h.r.report({ kind: "progress", pct: 0 });
    h.r.report({ kind: "progress", pct: 10 });
    expect(h.frames).toEqual([
      { state: "queued" },
      { state: "loading", pct: 0 },
      { state: "loading", pct: 100 },
      { state: "separating", pct: 0 },
      { state: "separating", pct: 10 },
    ]);
    expect(h.phases.at(-1)).toEqual({ state: "separating", pct: 10 }); // a second requester gets the truth
    h.r.stop();
  });

  it("losing anchor WHILE QUEUED stops within one beat — when nothing else would ever emit", () => {
    // Anchor loss is checked on emission. A queued request emits nothing but beats, so without the
    // beat a host that lost anchor kept its subscription until the job settled.
    const h = harness();
    h.loseAnchor();
    vi.advanceTimersByTime(BEAT);
    expect(h.frames).toEqual([{ state: "queued" }]); // said nothing after losing anchor
    expect(h.unsubscribe).toHaveBeenCalled(); // and let go of the download subscription
    vi.advanceTimersByTime(BEAT * 4);
    expect(h.frames).toEqual([{ state: "queued" }]); // and never beats again
    expect(vi.getTimerCount()).toBe(0); // the beat itself is GONE, not merely silent
  });

  it("a failure is REFUSED with its reason, and the beating stops", () => {
    const h = harness();
    h.r.report({ kind: "failed", reason: "The host changed the track on that deck." });
    expect(h.frames.at(-1)).toEqual({ state: "refused", reason: "The host changed the track on that deck." });
    const n = h.frames.length;
    vi.advanceTimersByTime(BEAT * 4);
    expect(h.frames.length).toBe(n);
    expect(h.unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() is final and idempotent — success, refusal and anchor loss can all reach it", () => {
    const h = harness();
    h.r.stop();
    h.r.stop();
    // ★ WHY THIS LINE EXISTS: with the interval left running, every FRAME assertion below still passes —
    // the beat's callback sees `stopped` and returns before emitting. A stopped-but-running timer is
    // silent, so only counting live timers can see it leak, once per request, for the whole session.
    // Found by a control (clearInterval removed) that left all 8 tests green.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(BEAT * 4);
    h.r.report({ kind: "progress", pct: 90 });
    h.load(50);
    expect(h.frames).toEqual([{ state: "queued" }]);
  });
});

// THE HOST'S VOICE FOR ONE STEM REQUEST — which phase it is in, said when it changes AND on a clock.
//
// Extracted from useStemViewSync so the part most likely to fail SILENTLY is a tested function the
// hook imports, not inline logic beside a test that exercises something else. Each failure mode below
// looks healthy from the host's side and shows up only on the requester, as a false "the host stopped
// reporting progress":
//
//  • A QUEUED request has no progress of its own for as long as the work ahead of it takes — the
//    auto-mixer preloads the next track AND the one after through the one-at-a-time GPU queue, and a
//    transition HOLD stops new jobs starting. Step-gated reporting says nothing, and the requester's
//    stall watchdog fires on a host that is fine. So the current phase is re-sent every heartbeatMs.
//  • The heartbeat must BYPASS the step gate. A beat is not a new step, so a gate drops every beat
//    after the first and "queued" goes silent anyway. Rate-limited by TIME instead.
//  • A beat carries the last percentage SENT. A pct-less frame renders as "separating…", so sending
//    undefined would flicker "40%" away between steps.
//  • One step gate PER PHASE. makeProgressGate never goes backwards, so a gate shared across phases lets
//    a finished download (100) suppress separation restarting from 0 — only ever visible on a cold host.
//  • Anchor loss is checked on every emission, and the heartbeat IS an emission on a clock — so a host
//    that loses anchor while queued, when nothing else would emit, still stops within one beat.
//  • ONE idempotent teardown, used by every terminal path: success, failure, refusal, anchor loss.

import { makeProgressGate } from "./progressGate";
import type { StemAckState } from "./protocol";

export type StemRequestEvent = { kind: "progress"; pct: number } | { kind: "failed"; reason: string };

export interface StemRequestReporterDeps {
  /** Emit one stemsAck frame for this request. */
  ack: (state: StemAckState, reason?: string, pct?: number) => void;
  /** Is this device still the session's separation authority? Read on every emission. */
  isAuthority: () => boolean;
  /** Subscribe to model-download progress (0..100); returns the unsubscribe. */
  subscribeLoading: (cb: (pct: number) => void) => () => void;
  /** Told the phase on every change, so a second requester can be given the truth. */
  onPhase?: (state: StemAckState, pct?: number) => void;
  heartbeatMs: number;
  step: number;
}

export interface StemRequestReporter {
  /** Feed separation progress (0..100) or a failure. */
  report: (e: StemRequestEvent) => void;
  /** Tear down: stop beating, unsubscribe. Idempotent. */
  stop: () => void;
}

export function startStemRequestReporter(d: StemRequestReporterDeps): StemRequestReporter {
  const sepGate = makeProgressGate(d.step);
  const loadGate = makeProgressGate(d.step);
  let phase: StemAckState = "queued";
  let phasePct: number | undefined;
  // Assigned before anything can call stop(); a no-op until subscribed, so an early stop is safe.
  let stopLoad: () => void = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    stopLoad();
    if (beat !== undefined) clearInterval(beat);
    beat = undefined;
  };
  const stillAuthority = () => {
    if (stopped) return false;
    if (d.isAuthority()) return true;
    stop();
    return false;
  };
  const say = (state: StemAckState, pct?: number) => {
    phase = state;
    phasePct = pct;
    d.onPhase?.(state, pct);
    d.ack(state, undefined, pct);
  };

  say("queued");
  beat = setInterval(() => {
    if (!stillAuthority()) return;
    d.ack(phase, undefined, phasePct); // the CURRENT fact — deliberately not through a gate
  }, d.heartbeatMs);
  stopLoad = d.subscribeLoading((p) => {
    if (!stillAuthority()) return;
    const pct = loadGate(p);
    if (pct === null) return;
    say("loading", pct);
  });

  const report = (e: StemRequestEvent) => {
    if (!stillAuthority()) return;
    if (e.kind === "failed") {
      stop();
      d.ack("refused", e.reason);
      return;
    }
    const pct = sepGate(e.pct);
    if (pct === null) return;
    say("separating", pct);
  };

  return { report, stop };
}

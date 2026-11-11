// Loop / cue / hot-cue subsystem, factored out of Deck (which delegates to it, like it
// already delegates EQ→Eq3 and FX→FxRack). LoopEngine OWNS the loop/cue STATE and all the
// editing logic; it reaches back into the deck's transport only through the narrow
// `LoopHost` callback interface below, so no Deck internals are exposed. Deck keeps
// forwarding getters (`get loop()` → `this.loops.loop`) + thin delegator methods, so every
// existing `deck.loop` reader and `deck.setBeatLoop()` caller is unchanged.
import type { Beatgrid } from "../analysis/analyze";
import { beatTimeOffset, nearestBeat } from "../analysis/analyze";

/** Pads per hot-cue bank, and the number of hot cues (two banks: CUE 1–8, CUE 2 9–16). */
export const HOT_CUE_BANK = 8;
export const HOT_CUE_COUNT = 16;
const ADJUST_FINE_BEATS = 1 / 16;

export interface Loop {
  active: boolean;
  start: number;
  end: number;
  beats: number;
}

/** What a local loop mutation did, handed to the session broadcaster (LoopHost.onLoopEdit).
 *  `action` is the gesture's NAME (the wire carries it for older peers and for logs); the RESULT is
 *  read off the engine (loopState) by the broadcaster. `seek` is where the mutation moved the
 *  playhead, when it did (reloop / recall / roll / a shrunk loop pulling the head back). */
export type LoopEditAction = "in" | "out" | "beat" | "reloop" | "exit" | "roll" | "clear" | "bounds";
export interface LoopEdit {
  action: LoopEditAction;
  beats?: number;
  seek?: number;
}
/** The absolute loop state a session carries: the region (or none) and any pending manual in-point. */
export interface LoopState {
  loop: Loop | null;
  inPoint: number | null;
}

/** The transport primitives LoopEngine needs from its deck — supplied as bound
 *  callbacks so the deck's private clock/worklet internals stay private. */
export interface LoopHost {
  position(): number;
  seek(t: number): void;
  reanchorClock(): void;
  rebaseClock(): void;
  /** Un-wrapped clock offset = where playback would be with no loop (for rollOut). */
  rawOffset(): number;
  /** Post the loop window to the stretch worklet. */
  postLoop(active: boolean, start: number, end: number): void;
  beatgrid(): Beatgrid | null;
  duration(): number;
  playing(): boolean;
  loaded(): boolean;
  quantize(): boolean;
  /** Fired after EVERY local loop mutation so the App can broadcast the absolute result to a
   *  session. Never fired by the apply* paths (a peer's result, a snapshot, a tick heal). */
  onLoopEdit(edit: LoopEdit): void;
}

export class LoopEngine {
  cuePoint = 0;
  hotCues: (number | null)[] = new Array(HOT_CUE_COUNT).fill(null);
  hotLoops: (Loop | null)[] = new Array(HOT_CUE_COUNT).fill(null); // saved loops per pad
  loop: Loop | null = null;
  loopInPoint: number | null = null; // pending manual loop-in (FLX4 style)
  // Loop-boundary fine-adjust: when set, waveform drag / scroll / arrow keys move
  // that boundary instead of seeking. Mirrors the rekordbox IN/OUT "head editor".
  adjusting: "in" | "out" | null = null;

  constructor(private host: LoopHost) {}

  // ★ EVERY LOCAL LOOP MUTATION ENDS IN ONE ABSOLUTE BROADCAST (operator, 2026-11-11: session sync
  // audit). in/out/exit/reloop/roll/clear/recall never fired onLoopEdit, so the session heard only
  // the gesture's NAME and every receiver re-ran it at ITS playhead, ~100 ms later, on ITS grid and
  // ITS quantize flag: different regions, a whole beat off about one press in five with quantize on,
  // and a lost IN turned the next OUT into a no-op. The broadcaster now reads the RESULT
  // (loopState) after the mutation, and `seek` says where the head was moved, if anywhere.
  private seeked: number | null = null;
  private seekTo(t: number) {
    this.seeked = t;
    this.host.seek(t);
  }
  private edited(action: LoopEditAction, beats?: number) {
    const seek = this.seeked;
    this.seeked = null;
    this.host.onLoopEdit({ action, ...(beats != null ? { beats } : {}), ...(seek != null ? { seek } : {}) });
  }
  /** The absolute loop state — what a session broadcast carries. */
  loopState(): LoopState {
    return { loop: this.loop ? { ...this.loop } : null, inPoint: this.loopInPoint };
  }
  /** Adopt a peer's absolute loop state VERBATIM: no snap, no recompute, no broadcast. `inPoint`
   *  undefined leaves the pending in-point alone (a loopBounds message does not carry it); `seek`
   *  is where the sender's mutation put its playhead. Without a seek, a playing head left outside a
   *  freshly active region is pulled to its start, as setBeatLoop does locally. */
  applyLoopState(loop: { start: number; end: number; active: boolean; beats?: number } | null, inPoint?: number | null, seek?: number) {
    if (loop && !(loop.end > loop.start)) return; // inverted / NaN region: ignore (as applyLoopRegion)
    const wasActive = !!this.loop?.active;
    if (wasActive && !loop?.active) this.host.rebaseClock(); // anchor before unwrapping
    else if (loop?.active) this.host.reanchorClock(); // phase-lock across the reshape
    this.loop = loop ? { active: loop.active, start: loop.start, end: loop.end, beats: loop.beats ?? this.loopBeats({ ...loop, beats: 0 }) } : null;
    if (inPoint !== undefined) this.loopInPoint = inPoint;
    if (!this.loop) this.adjusting = null;
    this.applyLoop();
    if (seek != null) this.host.seek(seek);
    else if (this.loop?.active && this.host.playing()) {
      const pos = this.host.position();
      if (pos < this.loop.start || pos > this.loop.end) this.host.seek(this.loop.start);
    }
  }
  /** Adopt a peer's hot-cue slot VERBATIM (the cue time, or the saved loop on it). No broadcast. */
  applyHotCue(i: number, cue: number | null, loop: { start: number; end: number; beats?: number } | null) {
    if (i < 0 || i >= HOT_CUE_COUNT) return;
    this.hotCues[i] = loop ? null : cue;
    this.hotLoops[i] = loop && loop.end > loop.start ? { active: false, start: loop.start, end: loop.end, beats: loop.beats ?? this.loopBeats({ active: false, start: loop.start, end: loop.end, beats: 0 }) } : null;
  }

  /** Clear all loop/cue state (a fresh track load). */
  reset() {
    this.cuePoint = 0;
    this.hotCues = new Array(HOT_CUE_COUNT).fill(null);
    this.hotLoops = new Array(HOT_CUE_COUNT).fill(null);
    this.loop = null;
    this.loopInPoint = null;
  }

  private snap(t: number): number {
    const g = this.host.beatgrid();
    if (!g) return t;
    return nearestBeat(g, t); // dynamic grid aware (falls back to the uniform comb)
  }
  private maybeSnap(t: number): number {
    return this.host.quantize() ? this.snap(t) : t;
  }

  // --- cue ---
  setCue() {
    this.cuePoint = this.maybeSnap(this.host.position());
  }
  jumpToCue() {
    this.host.seek(this.cuePoint);
  }

  // --- hot cues: tap empty pad to set, tap set pad to jump ---
  hotCue(i: number) {
    // A saved loop on this pad takes priority: recall + activate it.
    if (this.hotLoops[i]) {
      this.recallLoop(i);
      return;
    }
    const cur = this.hotCues[i];
    if (cur == null) this.hotCues[i] = this.maybeSnap(this.host.position());
    else this.host.seek(cur);
  }
  clearHotCue(i: number) {
    this.hotCues[i] = null;
    this.hotLoops[i] = null;
  }
  slotIsSet(i: number): boolean {
    return this.hotCues[i] != null || this.hotLoops[i] != null;
  }

  /** Save the current loop to pad `i` (so it can be recalled later). */
  saveLoop(i: number): boolean {
    if (!this.loop) return false;
    this.hotLoops[i] = { ...this.loop, active: false };
    this.hotCues[i] = null;
    return true;
  }
  /** Recall + activate the loop saved on pad `i`. */
  recallLoop(i: number) {
    const l = this.hotLoops[i];
    if (!l) return;
    this.loop = { ...l, active: true };
    this.applyLoop();
    this.seekTo(l.start);
    this.edited("reloop");
  }

  // --- loops ---
  /** Set + enable a loop of `beats` length, snapped to the beatgrid.
   *  Resizing an ACTIVE loop keeps its in-point anchored (rekordbox behaviour),
   *  so 1/2/4/8 changes the length in place instead of jumping the loop to the
   *  playhead. With no active loop, drop a fresh loop at the current position. */
  setBeatLoop(beats: number) {
    if (!this.host.loaded()) return;
    const g = this.host.beatgrid();
    const interval = g?.interval ?? 60 / 120;
    const start = this.loop?.active ? this.loop.start : g ? this.snap(this.host.position()) : this.host.position();
    // End on the beat `beats` away on the actual grid (exact even if tempo drifts),
    // not start + beats·interval which only holds for a perfectly constant tempo.
    // `beats` can be sub-1 (1/2 … 1/16); beatTimeOffset interpolates the fraction.
    const rawEnd = g ? beatTimeOffset(g, start, beats) : start + beats * interval;
    // Never let the loop collapse to a degenerate/NaN window — a sub-quantum or NaN
    // loopEnd hangs/crackles the source node. Floor it at ~5 ms (well below any
    // musical 1/16-beat loop, which is ≥~20 ms) and fall back to the interval math.
    const MIN_LOOP = 0.005;
    let end = Math.min(this.host.duration(), rawEnd);
    if (!(end > start + MIN_LOOP)) end = Math.min(this.host.duration(), start + Math.max(MIN_LOOP, beats * interval));
    this.host.reanchorClock(); // collapse the loop-phase accumulator before the bounds change
    this.loop = { active: true, start, end, beats };
    this.applyLoop();
    // Keep the playhead inside the (possibly shrunk) region so a live source
    // doesn't run past the new loopEnd before wrapping.
    if (this.host.playing()) {
      const pos = this.host.position();
      if (pos < start || pos > end) this.seekTo(start);
    }
    // ★ BROADCAST THE ABSOLUTE REGION TOO, because `beats` is not a portable quantity. The
    // {kind:"loop", action:"beat"} intent carries a COUNT, and the receiver resolves it against ITS
    // OWN beatgrid — so two devices holding different grids for the same track get different loop
    // lengths and different start points from one press. That is not hypothetical: mayReuseGrid
    // (94fe1f0) refuses a pooled grid whose stored duration does not match the decoded audio, so
    // one device can be on the pooled grid while another re-derived locally, TODAY. A re-version
    // rollout would make it the normal case rather than the edge one (Deckard, docs/
    // analysis-reversioning.md).
    // This fires the same callback loop fine-adjust already uses, so the session hears the region
    // the DJ actually set rather than its own re-derivation of the count. Absolute wins because
    // absolute is the only thing both devices agree about.
    this.edited("beat", beats);
  }

  // FLX4-style manual loop. With no active loop: tap IN to drop the entry point,
  // tap OUT to set the exit and start looping. With a loop already running, IN
  // and OUT nudge that loop's in/out boundaries so it can be fine-tuned.
  loopIn() {
    const t = this.maybeSnap(this.host.position());
    if (this.loop?.active) {
      this.host.reanchorClock(); // phase-lock the playhead across the in-point nudge
      this.loop.start = Math.min(t, this.loop.end - 1e-3);
      this.loop.beats = this.loopBeats(this.loop);
      this.applyLoop();
      if (this.host.playing() && this.host.position() < this.loop.start) this.seekTo(this.loop.start);
    } else {
      this.loopInPoint = t;
    }
    this.edited("in");
  }
  loopOut() {
    const t = this.maybeSnap(this.host.position());
    if (this.loop?.active) {
      if (t > this.loop.start) {
        this.host.reanchorClock(); // phase-lock the playhead across the out-point nudge
        this.loop.end = t;
        this.loop.beats = this.loopBeats(this.loop);
        this.applyLoop();
        this.edited("out");
      }
      return;
    }
    if (this.loopInPoint == null) return;
    const start = this.loopInPoint;
    const end = t;
    this.loopInPoint = null;
    if (end <= start) return void this.edited("out"); // the in-point is spent either way: say so
    this.loop = { active: true, start, end, beats: 0 };
    this.loop.beats = this.loopBeats(this.loop);
    this.applyLoop();
    this.edited("out");
  }

  private loopBeats(loop: Loop): number {
    const interval = this.host.beatgrid()?.interval ?? 60 / 120;
    return Math.max(1, Math.round((loop.end - loop.start) / interval));
  }

  /** Current loop region (absolute), or null — the setpoint sent over a session. */
  loopRegion(): { start: number; end: number; active: boolean } | null {
    return this.loop ? { start: this.loop.start, end: this.loop.end, active: this.loop.active } : null;
  }
  /** Apply an absolute loop region from a session peer (fine-adjust / move sync). */
  applyLoopRegion(start: number, end: number, active: boolean) {
    if (end <= start) return;
    this.host.reanchorClock(); // phase-lock the playhead across a peer's loop reshape
    this.loop = { active, start, end, beats: this.loopBeats({ active, start, end, beats: 0 }) };
    this.applyLoop();
  }

  /** Shift the whole loop by `beats` (keeping its length), grid-locked. Positive
   *  = forward. Used to move a loop a bar/beat at a time without resizing it. */
  moveLoop(beats: number) {
    if (!this.loop) return;
    const interval = this.host.beatgrid()?.interval ?? 60 / 120;
    const len = this.loop.end - this.loop.start;
    let start = this.loop.start + beats * interval;
    if (start < 0) start = 0;
    if (start + len > this.host.duration()) start = Math.max(0, this.host.duration() - len);
    this.host.reanchorClock(); // phase-lock the playhead across the loop move
    this.loop = { ...this.loop, start, end: start + len };
    this.applyLoop();
    if (this.host.playing() && this.loop.active) {
      const pos = this.host.position();
      if (pos < start || pos > start + len) this.seekTo(start);
    }
    this.edited("bounds");
  }
  reloop() {
    if (!this.loop) return;
    this.loop.active = true;
    this.applyLoop();
    this.seekTo(this.loop.start);
    this.edited("reloop");
  }

  toggleLoop() {
    if (!this.loop) return;
    if (this.loop.active) this.host.rebaseClock(); // turning OFF: anchor before unwrapping
    this.loop.active = !this.loop.active;
    this.applyLoop();
    this.edited(this.loop.active ? "reloop" : "exit");
  }
  exitLoop() {
    if (!this.loop) return;
    this.host.rebaseClock();
    this.loop.active = false;
    this.adjusting = null; // leaving the loop ends any boundary edit (no stuck highlight)
    this.applyLoop();
    this.edited("exit");
  }

  /** Exit an active loop as a "loop roll": instead of staying put (exitLoop), jump
   *  to where the track WOULD be had it never looped — the un-wrapped clock — so the
   *  music snaps back on-beat after the momentary stutter. Pair with setBeatLoop()
   *  on press / rollOut() on release for a hold-to-roll pad. */
  rollOut() {
    if (!this.loop?.active) return;
    this.loop.active = false;
    if (this.host.playing()) {
      // Raw (un-wrapped) offset = where playback would have reached with no loop.
      const raw = this.host.rawOffset();
      this.applyLoop();
      this.seekTo(Math.max(0, Math.min(this.host.duration(), raw)));
    } else {
      this.applyLoop();
    }
    this.edited("roll");
  }

  /** Wipe the loop entirely (region + any pending in-point), so the deck plays
   *  straight through. Shift-RELOOP / Shift-EXIT. */
  clearLoop() {
    if (this.loop?.active) this.host.rebaseClock(); // anchor before the region disappears
    this.loop = null;
    this.loopInPoint = null;
    this.adjusting = null;
    this.applyLoop();
    this.edited("clear");
  }

  // --- loop-boundary fine-adjust (Shift-IN / Shift-OUT) ---
  /** Toggle loop-boundary fine-adjust (the IN/OUT "head editor"). A small state
   *  machine so the IN/OUT button highlights contextually and every press does
   *  something useful regardless of loop state:
   *    - same boundary already armed → disarm (toggle off)
   *    - IN → arm "in"; if there's no loop or in-point yet, drop one at the playhead
   *    - OUT → arm "out"; if only an in-point exists, close the loop here first so
   *      there's an end to nudge; with nothing at all, stay off (nothing to adjust) */
  toggleAdjust(which: "in" | "out"): "in" | "out" | null {
    if (this.adjusting === which) {
      this.adjusting = null;
      return null;
    }
    if (which === "in") {
      if (!this.loop && this.loopInPoint == null) {
        this.loopInPoint = this.maybeSnap(this.host.position());
        this.edited("in");
      }
      this.adjusting = "in";
    } else {
      if (!this.loop && this.loopInPoint != null) this.loopOut(); // close in→here, then adjust the end
      this.adjusting = this.loop ? "out" : null;
    }
    return this.adjusting;
  }
  endAdjust() {
    this.adjusting = null;
  }
  /** Position of the boundary currently under adjustment, or null. */
  private adjustAnchor(): number | null {
    if (this.adjusting === "in") return this.loop ? this.loop.start : this.loopInPoint;
    if (this.adjusting === "out") return this.loop ? this.loop.end : null;
    return null;
  }
  /** Place the boundary under adjustment at `pos` (clamped to the track, in kept
   *  before out), keeping the loop live + audible. Shared by drag / scroll / keys. */
  private setAdjustPos(pos: number) {
    pos = Math.max(0, Math.min(this.host.duration(), pos));
    if (this.loop?.active) this.host.reanchorClock(); // phase-lock the playhead before reshaping the live loop
    if (this.adjusting === "in") {
      if (this.loop) {
        this.loop.start = Math.min(pos, this.loop.end - 1e-3);
        this.loop.beats = this.loopBeats(this.loop);
        this.applyLoop();
        if (this.host.playing() && this.host.position() < this.loop.start) this.seekTo(this.loop.start);
      } else {
        this.loopInPoint = pos;
      }
    } else if (this.adjusting === "out" && this.loop) {
      this.loop.end = Math.max(pos, this.loop.start + 1e-3);
      this.loop.beats = this.loopBeats(this.loop);
      this.applyLoop();
    }
    this.edited(this.loop ? "bounds" : "in"); // broadcast the new region (or in-point) to a session
  }
  /** Continuous nudge of the adjusted boundary by `deltaSec` (waveform drag). The
   *  lock follows the grid magnet: quantize on → the boundary snaps to the nearest
   *  grid beat as you drag; off → it moves freely for surgical sub-beat placement. */
  adjustBy(deltaSec: number) {
    const cur = this.adjustAnchor();
    if (cur == null) return;
    this.setAdjustPos(this.maybeSnap(cur + deltaSec));
  }
  /** Discrete step of the adjusted boundary by `units` (arrow keys / scroll ticks).
   *  Quantize on → move `units` whole beats along the real grid (lands on a beat);
   *  off → move a fine fraction of a beat so unlocked edits stay surgical. */
  adjustStep(units: number) {
    const cur = this.adjustAnchor();
    if (cur == null) return;
    const g = this.host.beatgrid();
    if (this.host.quantize() && g) {
      this.setAdjustPos(beatTimeOffset(g, cur, units));
    } else {
      const interval = g?.interval ?? 60 / 120;
      this.setAdjustPos(cur + units * interval * ADJUST_FINE_BEATS);
    }
  }

  /** Push the current loop window to the worklet (no-loop when invalid). */
  applyLoop() {
    const l = this.loop;
    // Only loop on a finite, non-degenerate window — a NaN/inverted loopEnd would
    // hang the engine's playhead wrap, so any bad value just falls back to no loop.
    const valid = !!l && l.active && Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start;
    this.host.postLoop(valid, valid ? l!.start : 0, valid ? l!.end : 0);
  }
}

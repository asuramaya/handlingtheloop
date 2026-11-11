// LOOP / HOT-CUE RESULTS ON THE WIRE — the sending half of loop sync.
//
// ★ RESULTS, NOT REQUESTS (operator, 2026-11-11: session sync audit). A loop or hot-cue intent used
// to say only what button was pressed, and every receiver re-ran the press at ITS playhead (~100 ms
// later), snapped to ITS grid with ITS quantize flag, against ITS stored cues. Two devices ended with
// different regions; with quantize on the receiver landed a whole beat off about one press in five;
// a lost IN made the next OUT a no-op; an empty-slot hot cue set a cue where the RECEIVER was.
// Every builder here reads what the sender's deck HOLDS after the gesture and puts that on the wire.
// The receiving half is applyIntent (state / cue / loop / position fields), which applies them
// verbatim and falls back to the old re-run only for a message from an older bundle.
//
// Pure: a structural deck in, an Intent out, so the two-device tests (loopSync.test.ts) drive the
// exact function the app sends with.

import type { DeckId, Intent, WireLoop, WireLoopState } from "./protocol";

/** The gesture a local loop mutation made — mirrors LoopEngine's LoopEdit (kept structural so this
 *  wire module imports nothing from the audio layer). */
export interface LoopEditLike {
  action: "in" | "out" | "beat" | "reloop" | "exit" | "roll" | "clear" | "bounds";
  beats?: number;
  seek?: number;
}
export interface LoopLike {
  start: number;
  end: number;
  active: boolean;
  beats: number;
}

const wireLoop = (l: LoopLike): WireLoop => ({ start: l.start, end: l.end, active: l.active, beats: l.beats });

/** The ONE broadcast a local loop mutation produces. A boundary move/adjust with a region rides
 *  `loopBounds` (older peers apply that verbatim already); everything else rides `loop` with the
 *  gesture's legacy name for older peers plus the full resulting `state` for newer ones. A roll and
 *  a SHIFT clear go out as "exit": an older bundle does not know those names and would fall through
 *  to a half-beat loop, while "exit" degrades to exactly what it did before. */
export function loopEditIntent(deck: DeckId, edit: LoopEditLike, state: { loop: LoopLike | null; inPoint: number | null }): Intent {
  const position = edit.seek != null ? { position: edit.seek } : {};
  if (edit.action === "bounds" && state.loop) {
    const l = state.loop;
    return { kind: "loopBounds", deck, start: l.start, end: l.end, active: l.active, beats: l.beats, ...position };
  }
  const action = edit.action === "roll" || edit.action === "clear" ? "exit" : edit.action === "bounds" ? "in" : edit.action;
  const wire: WireLoopState = { loop: state.loop ? wireLoop(state.loop) : null, inPoint: state.inPoint };
  return { kind: "loop", deck, action, ...(edit.beats != null ? { beats: edit.beats } : {}), state: wire, ...position };
}

/** What a hot-cue slot holds, for the wire. */
export interface HotCueDeckLike {
  hotCues: (number | null)[];
  hotLoops: (LoopLike | null)[];
}

/** A hot-cue PRESS or SAVE, carrying the slot's resulting contents and (for a press that moved the
 *  head) where it moved it to. `position` is the LANDED position, so a quantized jump sends the beat
 *  it actually landed on rather than the stored cue. */
export function hotCueResultIntent(deck: DeckId, slot: number, action: "press" | "save", d: HotCueDeckLike, position?: number): Intent {
  const l = d.hotLoops[slot];
  return {
    kind: "hotcue",
    deck,
    slot,
    action,
    cue: l ? null : (d.hotCues[slot] ?? null),
    loop: l ? { ...wireLoop(l), active: false } : null,
    ...(position != null ? { position } : {}),
  };
}

/** Does this hot-cue intent carry a result (a newer sender), or only the button (an older one)? */
export function hotCueHasResult(i: Extract<Intent, { kind: "hotcue" }>): boolean {
  return i.cue !== undefined || i.loop !== undefined;
}

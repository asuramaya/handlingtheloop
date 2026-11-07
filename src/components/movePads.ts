import type { Deck } from "@htl/audio";
import { EQ_MIN_DB } from "@htl/audio";
import type { FxPadDef } from "./fxPads";

// ★ FX2 IS THE MOVES BANK (operator, 2026-11-06: "transition tools are cool, maybe some of the
// effects and tools that are unmapped or do not have a clear space to be at could live in fx2 …
// lets try the first draft"). FX2 used to be the same eight effects as FX, aimed at the master
// chain, so with no stem chains it was an exact duplicate ("they feel the same"). FX stays the
// chain's effects; FX2 is eight DECK MOVES:
//   row 1 (0-3) = transport moves:   SPIN   CENSOR   BRAKE   ECHO OUT
//   row 2 (4-7) = transition tools:  FILTER OUT   BASS CUT   STUTTER   WASH
// Same gesture as every FX pad (fxPads): a plain press is live while held, SHIFT+press latches.
// A one-shot (SPIN, BRAKE) simply fires on the press.

/** What a held move has to put back when it is released, per deck. */
const saved = new WeakMap<Deck, { filter?: number; eqLow?: number; sweep?: ReturnType<typeof setInterval> }>();
const state = (d: Deck) => {
  let s = saved.get(d);
  if (!s) saved.set(d, (s = {}));
  return s;
};

/** Seconds per beat at the deck's playing tempo (120 bpm when there is no grid). */
const beatSec = (d: Deck) => (d.beatgrid?.interval ?? 0.5) / Math.max(0.25, d.rate || 1);

/** Sweep the colour filter from where it is toward `to` over `beats`, remembering where it began. */
function sweepFilter(d: Deck, to: number, beats: number) {
  const s = state(d);
  if (s.sweep) clearInterval(s.sweep);
  if (s.filter === undefined) s.filter = d.filterValue;
  const from = d.filterValue;
  const dur = beats * beatSec(d) * 1000;
  const t0 = performance.now();
  s.sweep = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    d.setFilter(from + (to - from) * k * k); // ease in: the last stretch is where it bites
    if (k >= 1 && s.sweep) {
      clearInterval(s.sweep);
      s.sweep = undefined;
    }
  }, 30);
}
function restoreFilter(d: Deck) {
  const s = state(d);
  if (s.sweep) clearInterval(s.sweep);
  s.sweep = undefined;
  if (s.filter !== undefined) d.setFilter(s.filter);
  s.filter = undefined;
}

export const MOVE_PADS: FxPadDef[] = [
  { label: "SPIN", hold: false, on: (d) => d.spinback(), hint: "Backspin — the record spun back, then playback carries on" },
  { label: "CENSOR", hold: true, on: (d) => d.censorBegin(), off: (d) => d.censorEnd(), active: (d) => d.reversing, hint: "Reverse while held; on release it lands where the track would be" },
  { label: "BRAKE", hold: false, on: (d) => d.releaseBrake(), hint: "Vinyl brake — the deck slows to a stop" },
  {
    label: "ECHO OUT",
    hold: true,
    on: (d) => d.echoOut(true),
    // The transition: the echo builds while held, then the dry track stops and only the tail is left.
    off: (d) => {
      d.echoOut(false);
      if (d.playing) d.pause();
    },
    active: (d) => d.echoingOut,
    hint: "Echo builds while held; on release the track stops and the echo tail rings out",
  },
  {
    label: "FILTER OUT",
    hold: true,
    on: (d) => sweepFilter(d, 0.9, 8),
    off: (d) => restoreFilter(d),
    active: (d) => state(d).filter !== undefined,
    hint: "High-pass sweep up over 2 bars while held; release snaps your filter back",
  },
  {
    label: "BASS CUT",
    hold: true,
    on: (d) => {
      const s = state(d);
      if (s.eqLow === undefined) s.eqLow = d.eqLow;
      d.setEqLow(EQ_MIN_DB);
    },
    off: (d) => {
      const s = state(d);
      if (s.eqLow !== undefined) d.setEqLow(s.eqLow);
      s.eqLow = undefined;
    },
    active: (d) => state(d).eqLow !== undefined,
    hint: "Kill the low end while held (the bass swap); release brings your EQ back",
  },
  {
    label: "STUTTER",
    hold: true,
    on: (d) => d.setBeatLoop(0.25),
    off: (d) => d.rollOut(),
    active: (d) => !!d.loop?.active && d.loop.beats === 0.25,
    hint: "1/4-beat roll while held; release snaps back on-beat",
  },
  {
    label: "WASH",
    hold: true,
    on: (d) => {
      d.reverbOut(true);
      sweepFilter(d, 0.6, 4);
    },
    off: (d) => {
      d.reverbOut(false);
      restoreFilter(d);
    },
    active: (d) => d.reverbingOut,
    hint: "Reverb wash with a filter rise while held; the tail blooms on release",
  },
];

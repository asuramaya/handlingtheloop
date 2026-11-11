// The beat grid as it crosses the wire inside a board snapshot.
//
// ★ ONE GRID PER TRACK PER SESSION (operator, 2026-11-11: session sync audit). Each device analysed
// a track on its own (or reused the pooled grid only when mayReuseGrid passed), so a host and a guest
// could hold grids that disagree by a few ms or by a whole downbeat — and quantize, beat loops, beat
// jump and sync phase then landed in different places on the two boards. The anchor's grid rides the
// snapshot and a follower adopts it for that videoId.
//
// COMPACT ON PURPOSE: the snapshot is republished on every board change and on a heartbeat, and it is
// fanned out to every listener. Beat and phrase times are sent as whole milliseconds, the first one
// absolute and the rest as deltas (a 5-minute track at 128 BPM is ~640 beats ≈ 2.6 KB), well inside
// the room's 128 KiB storage value cap (server/room.ts DO_VALUE_CAP). Half a millisecond of rounding
// is far below anything a beat-quantized action can hear. Round-trip stable: decode → encode gives
// the same wire form, so an adopted grid is never "different" from the snapshot that carried it.
import type { Beatgrid } from "../analysis/analyze";

export interface WireGrid {
  bpm: number;
  fb: number; // firstBeat (s)
  iv: number; // interval (s)
  b?: number[]; // beats: ms, first absolute then deltas
  db?: number; // downbeat index
  bpb?: number; // beats per bar
  ph?: number[]; // phrase starts: ms, first absolute then deltas
  pl?: string[]; // phrase labels
  pb?: number; // phraseBars
  fs?: number; // firstSound (s)
  ls?: number; // lastSound (s)
}

function packMs(a: ArrayLike<number>): number[] {
  const out: number[] = new Array(a.length);
  let prev = 0;
  for (let i = 0; i < a.length; i++) {
    const ms = Math.round(a[i] * 1000);
    out[i] = i === 0 ? ms : ms - prev;
    prev = ms;
  }
  return out;
}

function unpackMs(a: number[]): Float32Array {
  const out = new Float32Array(a.length);
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc = i === 0 ? a[0] : acc + a[i];
    out[i] = acc / 1000;
  }
  return out;
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function encodeGrid(g: Beatgrid | null | undefined): WireGrid | undefined {
  if (!g || !fin(g.bpm) || !(g.bpm > 0) || !fin(g.firstBeat) || !fin(g.interval)) return undefined;
  const w: WireGrid = { bpm: g.bpm, fb: g.firstBeat, iv: g.interval };
  if (g.beats && g.beats.length) w.b = packMs(g.beats);
  if (fin(g.downbeat)) w.db = g.downbeat;
  if (fin(g.beatsPerBar)) w.bpb = g.beatsPerBar;
  if (g.phrases && g.phrases.length) w.ph = packMs(g.phrases);
  if (g.phraseLabels && g.phraseLabels.length) w.pl = [...g.phraseLabels];
  if (fin(g.phraseBars)) w.pb = g.phraseBars;
  if (fin(g.firstSound)) w.fs = g.firstSound;
  if (fin(g.lastSound)) w.ls = g.lastSound;
  return w;
}

/** Null on anything malformed — a bad wire grid must never replace a good local one. */
export function decodeGrid(w: unknown): Beatgrid | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  if (!fin(o.bpm) || !(o.bpm > 0) || !fin(o.fb) || !fin(o.iv)) return null;
  const g: Beatgrid = { bpm: o.bpm, firstBeat: o.fb, interval: o.iv };
  const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every(fin);
  if (nums(o.b) && o.b.length) g.beats = unpackMs(o.b);
  if (fin(o.db)) g.downbeat = o.db;
  if (fin(o.bpb)) g.beatsPerBar = o.bpb;
  if (nums(o.ph) && o.ph.length) g.phrases = unpackMs(o.ph);
  if (Array.isArray(o.pl) && o.pl.every((s) => typeof s === "string")) g.phraseLabels = o.pl as string[];
  if (fin(o.pb)) g.phraseBars = o.pb;
  if (fin(o.fs)) g.firstSound = o.fs;
  if (fin(o.ls)) g.lastSound = o.ls;
  return g;
}

/** Does this local grid already say what the wire grid says? (Compared in wire form.) */
export function gridMatches(local: Beatgrid | null | undefined, w: WireGrid): boolean {
  const mine = encodeGrid(local);
  return !!mine && JSON.stringify(mine) === JSON.stringify(w);
}

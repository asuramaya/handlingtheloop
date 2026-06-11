// Offline analysis run once per loaded track:
//   - an LOD peak pyramid (mipmap of min/max + 3-band energy) so one waveform
//     viewport can zoom continuously from the whole track down to a few samples
//   - a beatgrid (bpm + first-beat phase + interval) for sync / loops / grid
// All single-pass / O(n) so it stays snappy even for long mixes.
import { FFT, hannPeriodic } from "../stems/fft";
import { detectBeats } from "./beats";

export interface PyramidLevel {
  bucket: number; // samples per bucket at this level
  min: Float32Array;
  max: Float32Array;
  low: Float32Array; // band energy, normalised 0..1
  mid: Float32Array;
  high: Float32Array;
}

export interface Pyramid {
  sampleRate: number;
  length: number; // samples
  levels: PyramidLevel[]; // level 0 = finest
}

export interface Beatgrid {
  bpm: number; // representative tempo (best-fit slope over the tracked beats)
  firstBeat: number; // seconds to first beat (constant-grid intercept)
  interval: number; // seconds per beat (constant-grid slope)
  // Dynamic grid: the actual tracked beat times (seconds), which flex with the
  // music's tempo. Absent when DP beat tracking couldn't run (very short clips);
  // consumers then fall back to the uniform firstBeat + k·interval comb. Use the
  // beat-query helpers below rather than reading this directly.
  beats?: Float32Array;
  // Downbeat (musical "1") detection: index in `beats[]` of the first downbeat —
  // beats at downbeat, downbeat+beatsPerBar, … start a bar. Lets the grid bold
  // real bar lines and lets sync align bars, not just beats. Assumes 4/4.
  downbeat?: number;
  beatsPerBar?: number;
  // Phrase (section) boundaries: times (s) of the downbeats that start an 8/16/32-
  // bar phrase, with the detected phrase length in bars. Drives phrase markers on
  // the grid and phrase-jump. Absent on short/structureless tracks.
  phrases?: Float32Array;
  phraseBars?: number;
}

export interface KeyInfo {
  tonic: number; // pitch class 0=C … 11=B
  mode: "major" | "minor";
  name: string; // "C", "Am", "F#m"
  camelot: string; // Camelot wheel code, "8B" / "8A"
}

export interface TrackAnalysis {
  bpm: number | null;
  beatgrid: Beatgrid | null;
  key: KeyInfo | null;
  pyramid: Pyramid;
}

// The minimal slice of AudioBuffer the analysers actually touch. Accepting this
// (rather than AudioBuffer) lets the whole analysis run in a Web Worker, which has
// no AudioBuffer — we hand it plain channel arrays wrapped in this shape. A real
// AudioBuffer satisfies it structurally, so main-thread callers are unchanged.
export interface AudioLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

const BASE_BUCKET = 256; // finest pyramid resolution (samples per bucket)

function lpAlpha(fc: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * fc) / sr);
}

/** Build the LOD pyramid: level 0 from the buffer, coarser levels by halving. */
export function computePyramid(buffer: AudioLike): Pyramid {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  return computePyramidFromChannels(ch0, ch1, buffer.sampleRate);
}

/** Same pyramid, from raw planar channels — usable off the main thread (the stem
 *  worker has Float32 channels, not an AudioBuffer). */
export function computePyramidFromChannels(ch0: Float32Array, ch1: Float32Array | null, sr: number): Pyramid {
  const n = ch0.length;

  const count = Math.max(1, Math.ceil(n / BASE_BUCKET));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const low = new Float32Array(count);
  const mid = new Float32Array(count);
  const high = new Float32Array(count);

  const aLow = lpAlpha(200, sr);
  const aMid = lpAlpha(2000, sr);
  let lp200 = 0;
  let lp2000 = 0;
  let bMin = 1;
  let bMax = -1;
  let lSum = 0;
  let mSum = 0;
  let hSum = 0;
  let cnt = 0;
  let bi = 0;
  let maxLow = 1e-9;
  let maxMid = 1e-9;
  let maxHigh = 1e-9;

  for (let i = 0; i < n; i++) {
    const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
    lp200 += aLow * (s - lp200);
    lp2000 += aMid * (s - lp2000);
    const lo = lp200;
    const md = lp2000 - lp200;
    const hi = s - lp2000;
    if (s < bMin) bMin = s;
    if (s > bMax) bMax = s;
    lSum += lo * lo;
    mSum += md * md;
    hSum += hi * hi;
    cnt++;
    if (cnt >= BASE_BUCKET || i === n - 1) {
      const l = Math.sqrt(lSum / cnt);
      const m = Math.sqrt(mSum / cnt);
      const h = Math.sqrt(hSum / cnt);
      min[bi] = bMin;
      max[bi] = bMax;
      low[bi] = l;
      mid[bi] = m;
      high[bi] = h;
      if (l > maxLow) maxLow = l;
      if (m > maxMid) maxMid = m;
      if (h > maxHigh) maxHigh = h;
      bi++;
      bMin = 1;
      bMax = -1;
      lSum = mSum = hSum = 0;
      cnt = 0;
    }
  }
  for (let i = 0; i < count; i++) {
    low[i] /= maxLow;
    mid[i] /= maxMid;
    high[i] /= maxHigh;
  }

  const levels: PyramidLevel[] = [{ bucket: BASE_BUCKET, min, max, low, mid, high }];
  while (levels[levels.length - 1].min.length > 1) {
    const prev = levels[levels.length - 1];
    const pc = prev.min.length;
    const nc = Math.ceil(pc / 2);
    const lvl: PyramidLevel = {
      bucket: prev.bucket * 2,
      min: new Float32Array(nc),
      max: new Float32Array(nc),
      low: new Float32Array(nc),
      mid: new Float32Array(nc),
      high: new Float32Array(nc),
    };
    for (let i = 0; i < nc; i++) {
      const a = i * 2;
      const b = Math.min(pc - 1, a + 1);
      lvl.min[i] = Math.min(prev.min[a], prev.min[b]);
      lvl.max[i] = Math.max(prev.max[a], prev.max[b]);
      lvl.low[i] = (prev.low[a] + prev.low[b]) * 0.5;
      lvl.mid[i] = (prev.mid[a] + prev.mid[b]) * 0.5;
      lvl.high[i] = (prev.high[a] + prev.high[b]) * 0.5;
    }
    levels.push(lvl);
  }

  return { sampleRate: sr, length: n, levels };
}

/** Lightweight min/max-only LOD pyramid for stem waveforms. Stems are coloured
 *  per-stem (not by frequency band), so this skips the band split — ~3× cheaper
 *  than computePyramid, keeping the one-time cost low when stems arrive. The
 *  low/mid/high arrays are present (zeroed) only to satisfy the shared type. */
export function computeStemPyramid(ch0: Float32Array, ch1: Float32Array | null, sr: number): Pyramid {
  const n = ch0.length;
  const count = Math.max(1, Math.ceil(n / BASE_BUCKET));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  let bMin = 1;
  let bMax = -1;
  let cnt = 0;
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
    if (s < bMin) bMin = s;
    if (s > bMax) bMax = s;
    if (++cnt >= BASE_BUCKET || i === n - 1) {
      min[bi] = bMin;
      max[bi] = bMax;
      bi++;
      bMin = 1;
      bMax = -1;
      cnt = 0;
    }
  }
  const zeros = (k: number) => new Float32Array(k);
  const levels: PyramidLevel[] = [{ bucket: BASE_BUCKET, min, max, low: zeros(count), mid: zeros(count), high: zeros(count) }];
  while (levels[levels.length - 1].min.length > 1) {
    const prev = levels[levels.length - 1];
    const pc = prev.min.length;
    const nc = Math.ceil(pc / 2);
    const lvl: PyramidLevel = { bucket: prev.bucket * 2, min: zeros(nc), max: zeros(nc), low: zeros(nc), mid: zeros(nc), high: zeros(nc) };
    for (let i = 0; i < nc; i++) {
      const a = i * 2;
      const b = Math.min(pc - 1, a + 1);
      lvl.min[i] = Math.min(prev.min[a], prev.min[b]);
      lvl.max[i] = Math.max(prev.max[a], prev.max[b]);
    }
    levels.push(lvl);
  }
  return { sampleRate: sr, length: n, levels };
}

/**
 * Beatgrid = a tracked beat sequence (dynamic grid) + a best-fit constant grid.
 * Delegates to the DP beat tracker (analysis/beats.ts), which is far more robust
 * than a single global tempo+phase: it follows real tempo drift so the grid
 * doesn't walk off the beats over a long track or when the deck's rate changes.
 * `detectBeatgridUniform` (below) is the legacy single-tempo detector, kept as a
 * last-ditch fallback for clips too short for the tracker.
 */
export function detectBeatgrid(buffer: AudioLike): Beatgrid | null {
  return detectBeats(buffer) ?? detectBeatgridUniform(buffer);
}

// ----------------------------- beat queries -------------------------------
// Helpers over a Beatgrid that prefer the dynamic `beats[]` when present and
// fall back to the uniform comb otherwise. Sync, snapping, and the grid renderer
// all go through these so dynamic + constant grids behave identically.

/** Index of the beat at-or-before time `t` in the dynamic array (binary search).
 *  Returns -1 if `t` precedes the first tracked beat. */
function beatIndexBefore(beats: Float32Array, t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  if (t < beats[0]) return -1;
  if (t >= beats[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Fractional beat phase at time `t`, 0..1 (0 = on a beat). Interpolates within
 *  the surrounding tracked interval, so it's accurate even where tempo drifts. */
export function beatPhase(g: Beatgrid, t: number): number {
  const beats = g.beats;
  if (beats && beats.length >= 2) {
    const i = beatIndexBefore(beats, t);
    if (i < 0) {
      // Before the first beat — extrapolate backwards at the local interval.
      const step = beats[1] - beats[0];
      const p = ((t - beats[0]) / step) % 1;
      return p < 0 ? p + 1 : p;
    }
    const next = i + 1 < beats.length ? beats[i + 1] : beats[i] + g.interval;
    const span = next - beats[i] || g.interval;
    const p = (t - beats[i]) / span;
    return p < 0 ? 0 : p >= 1 ? p - Math.floor(p) : p;
  }
  const p = ((t - g.firstBeat) / g.interval) % 1;
  return p < 0 ? p + 1 : p;
}

/** Nearest tracked beat time to `t` (snaps cues/loops/seeks to the real grid). */
export function nearestBeat(g: Beatgrid, t: number): number {
  const beats = g.beats;
  if (beats && beats.length >= 2) {
    const i = beatIndexBefore(beats, t);
    if (i < 0) return beats[0];
    if (i + 1 >= beats.length) return beats[i];
    return t - beats[i] <= beats[i + 1] - t ? beats[i] : beats[i + 1];
  }
  return g.firstBeat + Math.round((t - g.firstBeat) / g.interval) * g.interval;
}

/** Beat time `n` beats away from the beat at-or-before `t` (for beat jumps/loops).
 *  Uses the tracked sequence where available so a 4-beat jump lands on beat 4.
 *  `n` may be FRACTIONAL (sub-beat loops: 1/2, 1/4 … 1/16) — the fractional part is
 *  interpolated WITHIN the destination interval, so a 0.0625-beat loop is a real
 *  short slice, not an out-of-bounds (undefined → NaN) index that crashes the loop. */
export function beatTimeOffset(g: Beatgrid, t: number, n: number): number {
  const beats = g.beats;
  if (beats && beats.length >= 2) {
    const i = beatIndexBefore(beats, t);
    const base = i < 0 ? 0 : i;
    // beat-time for any (possibly out-of-range) integer index, extrapolating at the
    // edge interval beyond the tracked range.
    const beatAt = (idx: number): number => {
      if (idx >= 0 && idx < beats.length) return beats[idx];
      if (idx < 0) return beats[0] + idx * (beats[1] - beats[0]);
      const last = beats.length - 1;
      return beats[last] + (idx - last) * (beats[last] - beats[last - 1]);
    };
    const target = base + n;
    const lo = Math.floor(target);
    const frac = target - lo;
    const a = beatAt(lo);
    return frac === 0 ? a : a + frac * (beatAt(lo + 1) - a);
  }
  const base = g.firstBeat + Math.round((t - g.firstBeat) / g.interval) * g.interval;
  return base + n * g.interval;
}

/** The bar (downbeat-to-downbeat span) containing time `t`: its start time and
 *  length in seconds. Uses the detected downbeat phase on the dynamic grid; falls
 *  back to a beatsPerBar-long span anchored at firstBeat when no downbeat exists. */
export function barAnchor(g: Beatgrid, t: number): { start: number; length: number } {
  const bpb = g.beatsPerBar ?? 4;
  const beats = g.beats;
  if (beats && beats.length >= 2) {
    const phase = ((g.downbeat ?? 0) % bpb + bpb) % bpb;
    let i = beatIndexBefore(beats, t);
    if (i < 0) i = 0;
    // Step back to this bar's downbeat (largest s ≤ i with s ≡ phase mod bpb).
    let s = i - (((i - phase) % bpb) + bpb) % bpb;
    if (s < 0) s += bpb;
    if (s > i) s -= bpb;
    if (s < 0) s = 0;
    const startT = s < beats.length ? beats[s] : g.firstBeat + s * g.interval;
    const nextIdx = s + bpb;
    const endT = nextIdx < beats.length ? beats[nextIdx] : startT + bpb * g.interval;
    return { start: startT, length: endT - startT || bpb * g.interval };
  }
  const barLen = bpb * g.interval;
  const k = Math.floor((t - g.firstBeat) / barLen);
  return { start: g.firstBeat + k * barLen, length: barLen };
}

/** Fractional position within the current bar, 0..1 (0 = on the downbeat). Lets
 *  sync align bars, not just beats — so the two tracks' "1"s land together. */
export function barPhase(g: Beatgrid, t: number): number {
  const { start, length } = barAnchor(g, t);
  const p = (t - start) / length;
  return p < 0 ? 0 : p >= 1 ? p - Math.floor(p) : p;
}

/** Legacy single-tempo detector: onset-strength envelope → autocorrelation over
 *  60–180 BPM → best phase offset. Kept only as a fallback for clips too short for
 *  the DP tracker. Produces a uniform grid (no dynamic `beats[]`). */
function detectBeatgridUniform(buffer: AudioLike): Beatgrid | null {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const hop = 256;
  const envRate = sr / hop;
  const frames = Math.floor(ch.length / hop);
  if (frames < envRate * 4) return null;

  // Onset strength: positive change in a lightly log-compressed amplitude
  // envelope (compression evens out loud drops vs quiet intros so onsets in both
  // contribute to the tempo estimate).
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) sum += Math.abs(ch[start + i]);
    const e = Math.log1p(40 * (sum / hop));
    env[f] = Math.max(0, e - prev);
    prev = e;
  }

  const minLag = Math.max(2, Math.floor((60 * envRate) / 180));
  const maxLag = Math.ceil((60 * envRate) / 60);
  const scores = new Float32Array(maxLag + 2);
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += env[f] * env[f - lag];
    s /= frames - lag; // average correlation — fair across lags (no short-lag bias)
    const bpmL = (60 * envRate) / lag;
    // gentle log-normal prior centred on ~125 BPM tames octave errors
    s *= Math.exp(-0.5 * Math.pow(Math.log2(bpmL / 125) / 0.7, 2));
    scores[lag] = s;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return null;

  // Parabolic interpolation of the peak → fractional lag → sub-BPM precision.
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const sm1 = scores[bestLag - 1];
    const s0 = scores[bestLag];
    const sp1 = scores[bestLag + 1];
    const denom = sm1 - 2 * s0 + sp1;
    if (denom !== 0) lag = bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (sm1 - sp1)) / denom));
  }

  let bpm = (60 * envRate) / lag;
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;

  // Phase: slide a beat comb at the (fractional) interval and keep the offset that
  // collects the most onset energy. Sub-frame resolution from the fractional step.
  const intervalF = (60 * envRate) / bpm; // frames per beat
  const steps = Math.max(16, Math.round(intervalF));
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * intervalF;
    let score = 0;
    for (let b = phase; b < frames; b += intervalF) {
      const fi = Math.round(b);
      if (fi >= 0 && fi < frames) score += env[fi];
    }
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  return { bpm: Math.round(bpm * 100) / 100, firstBeat: bestPhase / envRate, interval: 60 / bpm };
}

export function analyzeTrack(buffer: AudioLike): TrackAnalysis {
  const beatgrid = detectBeatgrid(buffer);
  return { bpm: beatgrid?.bpm ?? null, beatgrid, key: detectKey(buffer), pyramid: computePyramid(buffer) };
}

/** Analyse from raw planar channels (what a Web Worker receives — no AudioBuffer).
 *  Wraps the channels in an AudioLike and runs the full pipeline. */
export function analyzeChannels(ch0: Float32Array, ch1: Float32Array | null, sampleRate: number): TrackAnalysis {
  const like: AudioLike = {
    sampleRate,
    length: ch0.length,
    numberOfChannels: ch1 ? 2 : 1,
    getChannelData: (c) => (c === 0 ? ch0 : (ch1 ?? ch0)),
  };
  return analyzeTrack(like);
}

// ----------------------------- musical key --------------------------------
// Krumhansl–Schmuckler major/minor key profiles, correlated against a whole-track
// chromagram (FFT energy folded onto the 12 pitch classes). The best-correlating
// of the 24 keys wins. Camelot codes are included for harmonic mixing.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Camelot by tonic pitch class (0=C). B side = major, A side = minor.
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

function keyName(tonic: number, mode: "major" | "minor"): string {
  return mode === "major" ? NOTE_NAMES[tonic] : `${NOTE_NAMES[tonic]}m`;
}

/** Transpose a key up by `semis` semitones (mode unchanged) — used to show the
 *  pitch-shifted "effective" key in the header. */
export function shiftKey(key: KeyInfo, semis: number): KeyInfo {
  const tonic = (((key.tonic + semis) % 12) + 12) % 12;
  return {
    tonic,
    mode: key.mode,
    name: keyName(tonic, key.mode),
    camelot: (key.mode === "major" ? CAMELOT_MAJOR : CAMELOT_MINOR)[tonic],
  };
}

export function detectKey(buffer: AudioLike): KeyInfo | null {
  const sr = buffer.sampleRate;
  const N = 8192;
  if (buffer.length < N) return null;
  const fft = new FFT(N);
  const win = hannPeriodic(N);
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const chroma = new Float64Array(12);
  const loBin = Math.max(1, Math.floor((65 * N) / sr)); // ~C2
  const hiBin = Math.min(N >> 1, Math.floor((2000 * N) / sr)); // ~B6
  // Cap the window count (~400) so key detection stays fast on long mixes.
  const hop = Math.max(N, Math.floor(buffer.length / 400));
  for (let pos = 0; pos + N <= buffer.length; pos += hop) {
    for (let i = 0; i < N; i++) {
      const s = ch1 ? (ch0[pos + i] + ch1[pos + i]) * 0.5 : ch0[pos + i];
      re[i] = s * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = loBin; k <= hiBin; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const freq = (k * sr) / N;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum <= 0) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= sum;

  let bestScore = -Infinity;
  let bestTonic = 0;
  let bestMode: "major" | "minor" = "major";
  for (let tonic = 0; tonic < 12; tonic++) {
    const maj = corr(chroma, KS_MAJOR, tonic);
    if (maj > bestScore) {
      bestScore = maj;
      bestTonic = tonic;
      bestMode = "major";
    }
    const min = corr(chroma, KS_MINOR, tonic);
    if (min > bestScore) {
      bestScore = min;
      bestTonic = tonic;
      bestMode = "minor";
    }
  }
  return {
    tonic: bestTonic,
    mode: bestMode,
    name: keyName(bestTonic, bestMode),
    camelot: (bestMode === "major" ? CAMELOT_MAJOR : CAMELOT_MINOR)[bestTonic],
  };
}

// Pearson correlation of the chroma (rotated so `tonic` aligns to profile[0])
// against a key profile.
function corr(chroma: Float64Array, profile: number[], tonic: number): number {
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sx2 = 0;
  let sy2 = 0;
  for (let i = 0; i < 12; i++) {
    const x = chroma[(tonic + i) % 12];
    const y = profile[i];
    sx += x;
    sy += y;
    sxy += x * y;
    sx2 += x * x;
    sy2 += y * y;
  }
  const num = 12 * sxy - sx * sy;
  const den = Math.sqrt((12 * sx2 - sx * sx) * (12 * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

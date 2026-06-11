// Offline analysis run once per loaded track:
//   - an LOD peak pyramid (mipmap of min/max + 3-band energy) so one waveform
//     viewport can zoom continuously from the whole track down to a few samples
//   - a beatgrid (bpm + first-beat phase + interval) for sync / loops / grid
// All single-pass / O(n) so it stays snappy even for long mixes.
import { FFT, hannPeriodic } from "../stems/fft";

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
  bpm: number;
  firstBeat: number; // seconds to first downbeat
  interval: number; // seconds per beat
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

const BASE_BUCKET = 256; // finest pyramid resolution (samples per bucket)

function lpAlpha(fc: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * fc) / sr);
}

/** Build the LOD pyramid: level 0 from the buffer, coarser levels by halving. */
export function computePyramid(buffer: AudioBuffer): Pyramid {
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
 * BPM + first-beat phase. Onset-strength envelope → autocorrelation over
 * 60–180 BPM → phase offset that best aligns a beat comb to the onsets.
 *
 * The tempo is refined to a FRACTIONAL lag (parabolic interpolation of the
 * autocorrelation peak): an integer-lag BPM is quantised in ~1.6-BPM steps at
 * 128 BPM, and even a ~1-BPM error drifts a uniform grid half a beat within ~30 s
 * — which is what throws the grid off across long intros/interludes. The score is
 * length-normalised and weighted by a gentle tempo prior so half/double-tempo
 * peaks don't win.
 */
export function detectBeatgrid(buffer: AudioBuffer): Beatgrid | null {
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

export function analyzeTrack(buffer: AudioBuffer): TrackAnalysis {
  const beatgrid = detectBeatgrid(buffer);
  return { bpm: beatgrid?.bpm ?? null, beatgrid, key: detectKey(buffer), pyramid: computePyramid(buffer) };
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

export function detectKey(buffer: AudioBuffer): KeyInfo | null {
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

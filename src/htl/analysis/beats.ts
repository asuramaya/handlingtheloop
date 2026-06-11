// Dynamic beat tracking — the backbone of sync, loops, and the on-screen grid.
//
// The old detector fit ONE global tempo + ONE phase to the whole track from a
// crude abs-amplitude onset envelope. That assumes a perfectly constant tempo:
// any error in `interval` (or any real tempo wobble) walks a uniform comb off the
// beats over time — worse at higher playback rate, where more beats pass per real
// second. That's why "the grid is off on load" and "the grid drifts when I move
// the tempo" are the SAME bug. The fix is to track the actual beat sequence.
//
// Pipeline (all offline, single pass, O(n)):
//   1. Spectral-flux onset envelope — STFT, log-magnitude, sum of positive
//      bin-to-bin change. Far more robust than abs-amplitude on bass-heavy or
//      sustained material; high-passed (local-mean subtraction) + normalised.
//   2. Tempo — autocorrelation of the envelope over 60–180 BPM with a gentle
//      log-normal prior (~125 BPM) so octave errors don't win; parabolic peak
//      interpolation for sub-BPM precision.
//   3. Beats — Ellis (2007) dynamic-programming beat tracking: the globally
//      optimal beat sequence that both lands on onsets AND keeps a near-constant
//      period. The result FLEXES with the music (a dynamic grid), not a rigid comb.
//   4. A best-fit constant grid (linear regression of the tracked beats) is
//      derived too, so every legacy consumer (loops, snap, sync fallback) keeps a
//      sensible bpm/firstBeat/interval.
import { FFT, hannPeriodic } from "../stems/fft";
import type { Beatgrid } from "./analyze";

const FFT_SIZE = 1024;
const HOP = 512;

/** Spectral-flux onset strength. Returns the (high-passed, unit-std) envelope and
 *  its frame rate (frames per second). */
function onsetEnvelope(buffer: AudioBuffer): { env: Float32Array; envRate: number } | null {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = ch0.length;
  if (n < FFT_SIZE * 4) return null;

  const fft = new FFT(FFT_SIZE);
  const win = hannPeriodic(FFT_SIZE);
  const bins = FFT_SIZE >> 1;
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const prevMag = new Float32Array(bins);

  const frames = Math.floor((n - FFT_SIZE) / HOP) + 1;
  if (frames < 8) return null;
  const flux = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = ch1 ? (ch0[start + i] + ch1[start + i]) * 0.5 : ch0[start + i];
      re[i] = s * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      // log-magnitude tames the loud-vs-quiet dynamic range so onsets in soft
      // passages still register against onsets in loud drops.
      const mag = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = mag - prevMag[k];
      if (d > 0) sum += d; // half-wave rectify: only energy INCREASES are onsets
      prevMag[k] = mag;
    }
    flux[f] = sum;
  }

  const envRate = sr / HOP;
  // High-pass: subtract a ~0.4 s moving average so a slow loudness swell doesn't
  // bias the DP, then rectify. Leaves crisp transient peaks on a zero floor.
  const halfWin = Math.max(1, Math.round(envRate * 0.2));
  const env = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += flux[f];
    if (f >= 2 * halfWin + 1) acc -= flux[f - (2 * halfWin + 1)];
    const wlen = Math.min(f + 1, 2 * halfWin + 1);
    const mean = acc / wlen;
    env[f] = Math.max(0, flux[f] - mean);
  }
  // Normalise to unit std so thresholds and DP costs are scale-free.
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += env[f];
  mean /= frames;
  let varSum = 0;
  for (let f = 0; f < frames; f++) {
    const d = env[f] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / frames) || 1;
  for (let f = 0; f < frames; f++) env[f] /= std;

  return { env, envRate };
}

/** Tempo (BPM) from the onset envelope via prior-weighted autocorrelation. */
function estimateTempo(env: Float32Array, envRate: number): number | null {
  const frames = env.length;
  const minLag = Math.max(2, Math.floor((60 * envRate) / 180));
  const maxLag = Math.min(frames - 1, Math.ceil((60 * envRate) / 60));
  if (maxLag <= minLag) return null;

  let bestLag = -1;
  let bestScore = -Infinity;
  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += env[f] * env[f - lag];
    s /= frames - lag; // average correlation — fair across lags (no short-lag bias)
    const bpmL = (60 * envRate) / lag;
    // gentle log-normal prior centred on ~125 BPM tames half/double octave errors
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
  return bpm;
}

/** Ellis (2007) dynamic-programming beat tracking. Returns beat frame indices.
 *  Finds the sequence of beats maximising onset alignment + period regularity. */
function trackBeats(env: Float32Array, envRate: number, bpm: number): number[] {
  const frames = env.length;
  const period = (60 * envRate) / bpm; // frames per beat
  if (period < 2 || frames < period * 2) return [];

  // localscore: lightly Gaussian-smoothed onset envelope (std = period/32) so a
  // single beat draws from a small neighbourhood, not one noisy frame.
  const sigma = Math.max(1, period / 32);
  const half = Math.ceil(sigma * 3);
  const kernel = new Float32Array(2 * half + 1);
  let ksum = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-0.5 * (i / sigma) * (i / sigma));
    kernel[i + half] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  const local = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = -half; i <= half; i++) {
      const j = f + i;
      if (j >= 0 && j < frames) s += env[j] * kernel[i + half];
    }
    local[f] = s;
  }

  // Predecessor search window: roughly [-2·period, -period/2]. The transition cost
  // is a log-squared penalty on deviating from the target period (tightness).
  const tightness = 100;
  const wMin = Math.round(period / 2);
  const wMax = Math.round(2 * period);
  const winLen = wMax - wMin + 1;
  const txcost = new Float32Array(winLen);
  for (let d = 0; d < winLen; d++) {
    const delta = wMin + d; // actual gap in frames (positive)
    txcost[d] = -tightness * Math.pow(Math.log(delta / period), 2);
  }

  const cumscore = new Float32Array(frames);
  const backlink = new Int32Array(frames).fill(-1);
  let localMax = 0;
  for (let f = 0; f < frames; f++) if (local[f] > localMax) localMax = local[f];
  const startThresh = 0.01 * localMax;
  let started = false;

  for (let f = 0; f < frames; f++) {
    let best = -Infinity;
    let bestPrev = -1;
    for (let d = 0; d < winLen; d++) {
      const prev = f - (wMin + d);
      if (prev < 0) break; // gaps only grow as d grows → rest are also invalid
      const score = txcost[d] + cumscore[prev];
      if (score > best) {
        best = score;
        bestPrev = prev;
      }
    }
    if (bestPrev < 0 || (!started && local[f] < startThresh)) {
      // No valid predecessor yet (or still in the silent lead-in): start fresh.
      cumscore[f] = local[f];
      backlink[f] = -1;
    } else {
      cumscore[f] = local[f] + best;
      backlink[f] = bestPrev;
      if (local[f] >= startThresh) started = true;
    }
  }

  // Choose the final beat: the strongest local maximum of cumscore in the tail,
  // then backtrace the links. Ellis picks the last cumscore peak above half the
  // median of all peaks, so a fade-out tail doesn't anchor on noise.
  const peaks: number[] = [];
  for (let f = 1; f < frames - 1; f++) {
    if (cumscore[f] > cumscore[f - 1] && cumscore[f] >= cumscore[f + 1]) peaks.push(f);
  }
  if (!peaks.length) return [];
  const sorted = peaks.map((p) => cumscore[p]).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const thresh = 0.5 * med;
  let tail = -1;
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (cumscore[peaks[i]] >= thresh) {
      tail = peaks[i];
      break;
    }
  }
  if (tail < 0) tail = peaks[peaks.length - 1];

  const beats: number[] = [];
  for (let f = tail; f >= 0; f = backlink[f]) {
    beats.push(f);
    if (backlink[f] < 0) break;
  }
  beats.reverse();
  return beats;
}

/** Least-squares fit of beat time = firstBeat + index·interval over the tracked
 *  beats — the best constant grid for legacy consumers (loops, snap, sync math). */
function fitConstantGrid(beatTimes: Float32Array): { firstBeat: number; interval: number } {
  const m = beatTimes.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < m; i++) {
    sx += i;
    sy += beatTimes[i];
    sxx += i * i;
    sxy += i * beatTimes[i];
  }
  const denom = m * sxx - sx * sx;
  const interval = denom !== 0 ? (m * sxy - sx * sy) / denom : beatTimes[1] - beatTimes[0];
  const firstBeat = (sy - interval * sx) / m;
  return { firstBeat, interval };
}

/** Full dynamic beat analysis → a Beatgrid carrying both the tracked `beats[]`
 *  (the dynamic grid) and a best-fit constant bpm/firstBeat/interval. */
export function detectBeats(buffer: AudioBuffer): Beatgrid | null {
  const onset = onsetEnvelope(buffer);
  if (!onset) return null;
  const bpm0 = estimateTempo(onset.env, onset.envRate);
  if (!bpm0) return null;

  const frameBeats = trackBeats(onset.env, onset.envRate, bpm0);
  if (frameBeats.length < 2) {
    // DP failed (very short / percussive-sparse) — fall back to a uniform grid at
    // the estimated tempo, phased to the global onset comb.
    return uniformFallback(onset.env, onset.envRate, bpm0);
  }

  const beats = new Float32Array(frameBeats.length);
  for (let i = 0; i < frameBeats.length; i++) beats[i] = frameBeats[i] / onset.envRate;

  const { firstBeat, interval } = fitConstantGrid(beats);
  const safeInterval = interval > 0.05 && interval < 2 ? interval : 60 / bpm0;
  const bpm = Math.round((60 / safeInterval) * 100) / 100;
  return { bpm, firstBeat, interval: safeInterval, beats };
}

/** Uniform-grid fallback (matches the old detector's phase search) when DP can't
 *  produce a beat sequence. No `beats[]`, so consumers use the constant comb. */
function uniformFallback(env: Float32Array, envRate: number, bpm: number): Beatgrid {
  const frames = env.length;
  const intervalF = (60 * envRate) / bpm;
  const steps = Math.max(16, Math.round(intervalF));
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * intervalF;
    let score = 0;
    for (let b = phase; b < frames; b += intervalF) {
      const fi = Math.round(b);
      if (fi >= 0 && fi < frames) score += env[fi];
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return { bpm: Math.round(bpm * 100) / 100, firstBeat: bestPhase / envRate, interval: 60 / bpm };
}

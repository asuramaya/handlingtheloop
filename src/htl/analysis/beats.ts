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
import type { AudioLike, Beatgrid } from "./analyze";

const FFT_SIZE = 1024;
const HOP = 512;
// Beat tracking only needs onset timing, not fidelity — onsets (kicks, snares,
// hats) all live below ~11 kHz. Decimating to ~22 kHz before the STFT halves the
// frame count (and the FFT cost) with no loss of beat accuracy, keeping the whole
// analysis well under a noticeable main-thread stall. (librosa defaults to 22050.)
const DECIM = 2;

/** Mono, box-filtered down by DECIM. Box averaging is a cheap anti-alias — enough
 *  since we only keep the magnitude envelope below Nyquist/2 for onsets. */
function decimateMono(buffer: AudioLike): { sig: Float32Array; sr: number } {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = ch0.length;
  const m = Math.floor(n / DECIM);
  const sig = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    let acc = 0;
    const base = i * DECIM;
    for (let k = 0; k < DECIM; k++) {
      const j = base + k;
      acc += ch1 ? (ch0[j] + ch1[j]) * 0.5 : ch0[j];
    }
    sig[i] = acc / DECIM;
  }
  return { sig, sr: buffer.sampleRate / DECIM };
}

/** Spectral-flux onset strength. Returns the full-band (high-passed, unit-std)
 *  onset envelope used for tempo + beats, plus a LOW-BAND flux envelope (sub-~150
 *  Hz, raw) used for downbeat detection — kicks land on the "1". */
function onsetEnvelope(buffer: AudioLike): { env: Float32Array; lowEnv: Float32Array; loudEnv: Float32Array; envRate: number } | null {
  const { sig, sr } = decimateMono(buffer);
  const n = sig.length;
  if (n < FFT_SIZE * 4) return null;

  const fft = new FFT(FFT_SIZE);
  const win = hannPeriodic(FFT_SIZE);
  const bins = FFT_SIZE >> 1;
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const prevMag = new Float32Array(bins);
  // Bins up to ~150 Hz carry the kick — their flux marks downbeats.
  const lowCut = Math.max(2, Math.min(bins - 1, Math.round((150 * FFT_SIZE) / sr)));

  const frames = Math.floor((n - FFT_SIZE) / HOP) + 1;
  if (frames < 8) return null;
  const flux = new Float32Array(frames);
  const lowEnv = new Float32Array(frames);
  const loudEnv = new Float32Array(frames); // broadband loudness → phrase structure

  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = sig[start + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let sum = 0;
    let lowSum = 0;
    let loud = 0;
    for (let k = 1; k < bins; k++) {
      const raw = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      loud += raw; // sustained spectral magnitude ≈ loudness (drops/breakdowns)
      // log-magnitude tames the loud-vs-quiet dynamic range so onsets in soft
      // passages still register against onsets in loud drops.
      const mag = Math.log1p(raw);
      const d = mag - prevMag[k];
      if (d > 0) {
        sum += d; // half-wave rectify: only energy INCREASES are onsets
        if (k <= lowCut) lowSum += d;
      }
      prevMag[k] = mag;
    }
    flux[f] = sum;
    lowEnv[f] = lowSum;
    loudEnv[f] = loud;
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

  return { env, lowEnv, loudEnv, envRate };
}

/** Estimate the 4/4 downbeat phase: the beat offset (0..beatsPerBar-1) whose beats
 *  carry the most low-band onset energy on average. Returns the index in `beats[]`
 *  of the first downbeat. Assumes 4/4 (overwhelmingly common in DJ material). */
function detectDownbeat(lowEnv: Float32Array, beatFrames: number[], beatsPerBar: number): number {
  const m = beatFrames.length;
  if (m < beatsPerBar * 2) return 0;
  // Per-beat low-band strength: sum a small window around each beat frame.
  const strength = new Float32Array(m);
  const w = 2;
  for (let i = 0; i < m; i++) {
    const c = beatFrames[i];
    let s = 0;
    for (let d = -w; d <= w; d++) {
      const f = c + d;
      if (f >= 0 && f < lowEnv.length) s += lowEnv[f];
    }
    strength[i] = s;
  }
  let bestPhase = 0;
  let best = -Infinity;
  for (let p = 0; p < beatsPerBar; p++) {
    let sum = 0;
    let cnt = 0;
    for (let i = p; i < m; i += beatsPerBar) {
      sum += strength[i];
      cnt++;
    }
    const avg = cnt ? sum / cnt : 0;
    if (avg > best) {
      best = avg;
      bestPhase = p;
    }
  }
  return bestPhase;
}

/** Phrase (section) detection. DJ tracks are built from 8/16/32-bar phrases —
 *  intro, build, drop, breakdown — whose boundaries land on bar lines where the
 *  energy changes. Build a per-bar broadband-loudness curve, take its bar-to-bar
 *  novelty (rises = builds/drops, falls = breakdowns both count), then find the
 *  phrase period P∈{8,16,32} and phase that best lines boundaries up with the big
 *  novelty spikes. Returns the boundary times (s) + detected phrase length. */
function detectPhrases(
  loudEnv: Float32Array,
  beatFrames: number[],
  beats: Float32Array,
  downbeat: number,
  beatsPerBar: number,
): { phrases: Float32Array; phraseBars: number } | null {
  const m = beats.length;
  const bpb = beatsPerBar;
  // Bar start beat indices (downbeats).
  const barStart: number[] = [];
  for (let i = downbeat; i < m; i += bpb) barStart.push(i);
  const numBars = barStart.length;
  if (numBars < 16) return null; // too short to assert phrase structure

  // Per-bar mean loudness over the bar's frame span.
  const barEnergy = new Float64Array(numBars);
  for (let b = 0; b < numBars; b++) {
    const startFrame = beatFrames[barStart[b]];
    const endBeat = b + 1 < numBars ? barStart[b + 1] : Math.min(m - 1, barStart[b] + bpb);
    const endFrame = beatFrames[endBeat];
    let s = 0;
    let c = 0;
    for (let f = startFrame; f < endFrame && f < loudEnv.length; f++) {
      s += loudEnv[f];
      c++;
    }
    barEnergy[b] = c ? s / c : 0;
  }

  // Bar-to-bar novelty (absolute change), normalised to its peak.
  const novelty = new Float64Array(numBars);
  let mx = 1e-9;
  for (let b = 1; b < numBars; b++) {
    novelty[b] = Math.abs(barEnergy[b] - barEnergy[b - 1]);
    if (novelty[b] > mx) mx = novelty[b];
  }
  for (let b = 0; b < numBars; b++) novelty[b] /= mx;

  // Search phrase period + phase. Average boundary novelty (counts differ across
  // P), nudged by a prior favouring 16-bar phrases (the dance-music default).
  const priors: Record<number, number> = { 8: 0.9, 16: 1, 32: 0.8 };
  let best = { score: -Infinity, P: 16, phi: 0 };
  for (const P of [8, 16, 32]) {
    if (numBars < P * 1.5) continue; // need a couple of phrases to trust period P
    for (let phi = 0; phi < P; phi++) {
      let sum = 0;
      let cnt = 0;
      for (let b = phi; b < numBars; b += P) {
        sum += novelty[b];
        cnt++;
      }
      if (cnt < 2) continue;
      const score = (sum / cnt) * priors[P];
      if (score > best.score) best = { score, P, phi };
    }
  }
  if (best.score <= 0) return null;

  const out: number[] = [];
  for (let b = best.phi; b < numBars; b += best.P) out.push(beats[barStart[b]]);
  return { phrases: Float32Array.from(out), phraseBars: best.P };
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
export function detectBeats(buffer: AudioLike): Beatgrid | null {
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
  const beatsPerBar = 4;
  const downbeat = detectDownbeat(onset.lowEnv, frameBeats, beatsPerBar);
  const phrase = detectPhrases(onset.loudEnv, frameBeats, beats, downbeat, beatsPerBar);
  return {
    bpm,
    firstBeat,
    interval: safeInterval,
    beats,
    downbeat,
    beatsPerBar,
    phrases: phrase?.phrases,
    phraseBars: phrase?.phraseBars,
  };
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

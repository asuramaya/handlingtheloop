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
//   1. Spectral-flux onset envelope — STFT, then a PERCUSSIVE-EMPHASIS pass (per-bin transient
//      excess over a slow sustained-level EMA; see percussiveMag) so pads/held vocals/vibrato
//      don't fake onsets, log-magnitude, sum of positive bin-to-bin change. Far more robust than
//      abs-amplitude on bass-heavy or sustained material; high-passed (local-mean subtraction) +
//      normalised. This is a drum DSP pass aimed at GRIDDING — no stem, no audio reconstructed.
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
import { buildSSM, l2normalize, labelSegments, multiScaleNovelty, pickBoundaries } from "./structure";

const FFT_SIZE = 1024;
const HOP = 512;
// Beat tracking only needs onset timing, not fidelity — onsets (kicks, snares,
// hats) all live below ~11 kHz. Decimating to ~22 kHz before the STFT halves the
// frame count (and the FFT cost) with no loss of beat accuracy, keeping the whole
// analysis well under a noticeable main-thread stall. (librosa defaults to 22050.)
const DECIM = 2;

// Percussive emphasis for the onset front-end (a "drum DSP pass aimed at GRIDDING" — NOT a stem:
// no audio is reconstructed, nothing is cached or played, it lives and dies inside this function).
// Each bin carries a slow EMA of its SUSTAINED magnitude (the harmonic estimate); the flux is then
// computed on the TRANSIENT excess over that baseline, so pads / held vocals / strings / vibrato /
// gated synths — sustained or modulated content that plain spectral flux misreads as onsets — are
// attenuated, while drum hits (which tower over their own baseline) stay crisp. It does NOT remove
// pitched ATTACKS (a piano stab is a transient too; that needs the neural stem or a learned model);
// it strips the harmonic WASH and concentrates the periodic percussive backbone the tracker locks to.
// Universal + ~free (one running EMA per bin), so mobile/no-cache gets the SAME grid as desktop —
// the whole point of doing this in the light metadata lane instead of leaning on stems.
const HARM_TAU_SEC = 0.4; // sustained-level EMA time constant (drums are far briefer → survive it)
const PERC_MIX = 0.7; // 1 = flux purely on the transient excess; 0 = plain flux. 0.7 keeps a raw floor so a non-percussive beat is never fully lost.

/** Transient-emphasised log-magnitude for one bin: blends the log-magnitude of the TRANSIENT excess
 *  (`raw − harm`, clamped ≥0) with the plain log-magnitude by `mix`. `harm` is a slow running estimate
 *  of the bin's sustained level. mix=1 → all-transient (sustained → 0); mix=0 → plain (ignores harm).
 *  Pure; the onset loop calls it per bin. This is the core of the percussive gridding pass. */
export function percussiveMag(raw: number, harm: number, mix: number): number {
  const perc = raw > harm ? raw - harm : 0;
  return (1 - mix) * Math.log1p(raw) + mix * Math.log1p(perc);
}

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

const CHROMA_BINS = 12;
// Musical range gate for the chroma bin→pitch-class map: below here is sub-bass with no clear
// pitch, above here is mostly cymbal/hat noise — both would just dilute the chroma with content
// that doesn't carry harmonic identity.
const CHROMA_F_LO = 60;
const CHROMA_F_HI = 5000;

/** Precompute, once per FFT_SIZE/sr, which pitch class (0=C..11=B) each FFT bin votes for, or -1
 *  to skip it (outside the musical range). A linear-frequency STFT bin maps only APPROXIMATELY
 *  to a pitch class — low bins span much more than a semitone each — but this is the standard
 *  lightweight "chroma from STFT bins" approach (vs. a full constant-Q transform, far more
 *  expensive to run client-side): plenty of harmonic discriminating power for section-level
 *  self-similarity, which only needs "sounds like a similar chord/key region", not exact pitch. */
function buildChromaBinMap(fftSize: number, sr: number): Int8Array {
  const bins = fftSize >> 1;
  const map = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = (k * sr) / fftSize;
    if (f < CHROMA_F_LO || f > CHROMA_F_HI) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    map[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  return map;
}

/** Spectral-flux onset strength. Returns the full-band (high-passed, unit-std)
 *  onset envelope used for tempo + beats, plus a LOW-BAND flux envelope (sub-~150
 *  Hz, raw) used for downbeat detection — kicks land on the "1" — plus a per-frame
 *  12-bin chroma (pitch-class energy profile), for structure detection (see structure.ts).
 *  Chroma rides the SAME per-frame magnitude spectrum already computed for onset flux — no
 *  second FFT pass, just one more accumulation per bin using a precomputed bin→pitch-class map. */
function onsetEnvelope(
  buffer: AudioLike,
): { env: Float32Array; lowEnv: Float32Array; loudEnv: Float32Array; chroma: Float32Array; envRate: number } | null {
  const { sig, sr } = decimateMono(buffer);
  const n = sig.length;
  if (n < FFT_SIZE * 4) return null;

  const fft = new FFT(FFT_SIZE);
  const win = hannPeriodic(FFT_SIZE);
  const bins = FFT_SIZE >> 1;
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const prevMag = new Float32Array(bins);
  const harm = new Float32Array(bins); // per-bin slow EMA of the sustained (harmonic) magnitude
  // Bins up to ~150 Hz carry the kick — their flux marks downbeats.
  const lowCut = Math.max(2, Math.min(bins - 1, Math.round((150 * FFT_SIZE) / sr)));
  // EMA coefficient for the sustained-level tracker (~HARM_TAU_SEC at this frame rate).
  const harmA = 1 - Math.exp(-1 / (HARM_TAU_SEC * (sr / HOP)));
  const chromaMap = buildChromaBinMap(FFT_SIZE, sr);

  const frames = Math.floor((n - FFT_SIZE) / HOP) + 1;
  if (frames < 8) return null;
  const flux = new Float32Array(frames);
  const lowEnv = new Float32Array(frames);
  const loudEnv = new Float32Array(frames); // broadband loudness → phrase structure
  const chroma = new Float32Array(frames * CHROMA_BINS); // per-frame pitch-class energy → structure

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
    const chromaBase = f * CHROMA_BINS;
    for (let k = 1; k < bins; k++) {
      const raw = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      loud += raw; // sustained spectral magnitude ≈ loudness (drops/breakdowns) — stays RAW
      const pc = chromaMap[k];
      if (pc >= 0) chroma[chromaBase + pc] += raw; // same magnitude, no extra FFT — see buildChromaBinMap
      // Transient-emphasised magnitude: measure the excess over this bin's sustained level (the
      // PRE-transient background — update the EMA after), so pads/vibrato/held tones don't drive
      // the flux. log-magnitude still tames the loud-vs-quiet dynamic range. See percussiveMag.
      const mag = percussiveMag(raw, harm[k], PERC_MIX);
      harm[k] += harmA * (raw - harm[k]);
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

  return { env, lowEnv, loudEnv, chroma, envRate };
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

// Checkerboard-novelty radii to try, in BARS (see structure.ts's multiScaleNovelty) — spans the
// range DJ phrases actually come in (a short fill through a whole 32-bar section). Filtered down
// to whatever fits the track's actual bar count at call time.
const NOVELTY_RADII_BARS = [4, 8, 16, 32];
// Minimum bars between two accepted section boundaries — short enough not to miss a real 8-bar
// phrase, long enough that the checkerboard novelty's own local-maximum picking (already
// spacing-aware) isn't fighting a second, redundant constraint at odds with it.
const MIN_BOUNDARY_SPACING_BARS = 8;
// Blend weight for the chroma (content) novelty vs. the loudness (energy) novelty — see
// detectStructure. Chroma gets the larger share: it catches transitions loudness alone misses
// (a verse→chorus at similar volume), which is the entire reason this replaced a loudness-only
// detector. Loudness stays in the mix because a pure energy build/drop can happen with almost no
// harmonic change (a filter sweep into a drop on the same chord), which chroma alone would miss.
const CHROMA_NOVELTY_WEIGHT = 0.6;

/** Structure (section) detection — Phase 2 + 3 from the design: a per-bar chroma self-similarity
 *  matrix + multi-scale checkerboard novelty finds VARIABLE-length section boundaries (replacing
 *  the old single-uniform-period comb fit, which could only ever describe a track as one fixed
 *  8/16/32-bar grid), blended with the loudness-novelty the old detector already used. The SAME
 *  matrix is then block-averaged between boundaries and greedily clustered (structure.ts's
 *  labelSegments) so a REPEATED section reuses its first letter — the rekordbox-style A/B/C/D
 *  labelling. Returns boundary times (s), their letters, and a representative bars-per-phrase
 *  (median segment length) for legacy consumers that jump by a fixed bar count when `phrases` is
 *  empty (Deck.phraseJump's fallback). Null on a track too short to assert any structure. */
function detectStructure(
  loudEnv: Float32Array,
  chroma: Float32Array,
  beatFrames: number[],
  beats: Float32Array,
  downbeat: number,
  beatsPerBar: number,
): { phrases: Float32Array; phraseLabels: string[]; phraseBars: number } | null {
  const m = beats.length;
  const bpb = beatsPerBar;
  // Bar start beat indices (downbeats).
  const barStart: number[] = [];
  for (let i = downbeat; i < m; i += bpb) barStart.push(i);
  const numBars = barStart.length;
  if (numBars < 16) return null; // too short to assert section structure

  // Per-bar mean loudness AND mean chroma over the bar's frame span — the same bar spans, two
  // different features, so both novelty curves talk about exactly the same points in time.
  const barEnergy = new Float64Array(numBars);
  const barChroma: Float32Array[] = [];
  for (let b = 0; b < numBars; b++) {
    const startFrame = beatFrames[barStart[b]];
    const endBeat = b + 1 < numBars ? barStart[b + 1] : Math.min(m - 1, barStart[b] + bpb);
    const endFrame = beatFrames[endBeat];
    let s = 0;
    let c = 0;
    const chromaVec = new Float32Array(CHROMA_BINS);
    for (let f = startFrame; f < endFrame && f < loudEnv.length; f++) {
      s += loudEnv[f];
      c++;
      const base = f * CHROMA_BINS;
      for (let p = 0; p < CHROMA_BINS; p++) chromaVec[p] += chroma[base + p];
    }
    barEnergy[b] = c ? s / c : 0;
    barChroma.push(l2normalize(chromaVec));
  }

  // Loudness novelty (bar-to-bar absolute change, normalised to its own peak) — the old
  // detector's whole signal, kept as one component of the blend (see CHROMA_NOVELTY_WEIGHT).
  const loudNovelty = new Float32Array(numBars);
  let loudPeak = 1e-9;
  for (let b = 1; b < numBars; b++) {
    loudNovelty[b] = Math.abs(barEnergy[b] - barEnergy[b - 1]);
    if (loudNovelty[b] > loudPeak) loudPeak = loudNovelty[b];
  }
  for (let b = 0; b < numBars; b++) loudNovelty[b] /= loudPeak;

  const ssm = buildSSM(barChroma);
  const radii = NOVELTY_RADII_BARS.filter((L) => numBars >= 2 * L + 1);
  const chromaNovelty = radii.length ? multiScaleNovelty(ssm, numBars, radii) : new Float32Array(numBars);

  const combined = new Float32Array(numBars);
  for (let b = 0; b < numBars; b++) {
    combined[b] = CHROMA_NOVELTY_WEIGHT * chromaNovelty[b] + (1 - CHROMA_NOVELTY_WEIGHT) * loudNovelty[b];
  }

  const boundaries = pickBoundaries(combined, numBars, MIN_BOUNDARY_SPACING_BARS);
  if (boundaries.length < 2) return null; // nothing distinguishable found beyond "the track starts"

  const phraseLabels = labelSegments(ssm, numBars, boundaries);
  const phrases = Float32Array.from(boundaries.map((b) => beats[barStart[b]]));

  // Representative bars-per-phrase (median segment length) for Deck.phraseJump's fallback jump
  // when `phrases` runs out — a diagnostic/legacy number now that sections are variable-length,
  // not the single defining period the old detector produced.
  const lens = boundaries.slice(1).map((b, i) => b - boundaries[i]);
  lens.push(numBars - boundaries[boundaries.length - 1]);
  lens.sort((a, b) => a - b);
  const phraseBars = lens.length ? lens[lens.length >> 1] : 16;

  return { phrases, phraseLabels, phraseBars };
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
  const structure = detectStructure(onset.loudEnv, onset.chroma, frameBeats, beats, downbeat, beatsPerBar);
  const bounds = contentBounds(onset.loudEnv, onset.envRate);
  return {
    bpm,
    firstBeat,
    interval: safeInterval,
    beats,
    downbeat,
    beatsPerBar,
    phrases: structure?.phrases,
    phraseLabels: structure?.phraseLabels,
    phraseBars: structure?.phraseBars,
    firstSound: bounds?.firstSound,
    lastSound: bounds?.lastSound,
  };
}

/** Content bounds from the broadband loudness envelope: the first / last time the track
 *  is meaningfully loud, trimming a quiet intro and a fade-out / dead tail. Threshold is a
 *  fraction of a ROBUST peak (90th-percentile loudness, so one spike doesn't set the bar),
 *  and we keep a small guard before/after the crossing so we don't clip a soft pickup note.
 *  Null when the envelope is too short or essentially flat (no usable structure). */
function contentBounds(loud: Float32Array, rate: number): { firstSound: number; lastSound: number } | null {
  const n = loud.length;
  if (n < 8 || rate <= 0) return null;
  const sorted = Float32Array.from(loud).sort();
  const p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))] || sorted[n - 1] || 0;
  if (p90 <= 0) return null;
  const thr = p90 * 0.12; // ~ -18 dB of the body loudness counts as "sound"
  let lo = 0;
  while (lo < n && loud[lo] < thr) lo++;
  let hi = n - 1;
  while (hi > lo && loud[hi] < thr) hi--;
  if (hi <= lo) return null; // flat / all-quiet → no usable bounds
  const guard = Math.round(rate * 0.25); // 0.25 s leeway so a soft onset/decay isn't clipped
  const firstSound = Math.max(0, lo - guard) / rate;
  const lastSound = Math.min(n - 1, hi + guard) / rate;
  return { firstSound, lastSound };
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

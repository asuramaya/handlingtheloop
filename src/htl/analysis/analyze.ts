// Offline analysis run once per loaded track:
//   - an LOD peak pyramid (mipmap of min/max + 3-band energy) so one waveform
//     viewport can zoom continuously from the whole track down to a few samples
//   - a beatgrid (bpm + first-beat phase + interval) for sync / loops / grid
// All single-pass / O(n) so it stays snappy even for long mixes.

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

export interface TrackAnalysis {
  bpm: number | null;
  beatgrid: Beatgrid | null;
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
  const n = ch0.length;
  const sr = buffer.sampleRate;

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

/**
 * BPM + first-beat phase. Onset-strength envelope → autocorrelation over
 * 60–180 BPM → phase offset that best aligns a beat comb to the onsets.
 */
export function detectBeatgrid(buffer: AudioBuffer): Beatgrid | null {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const hop = 256;
  const envRate = sr / hop;
  const frames = Math.floor(ch.length / hop);
  if (frames < envRate * 4) return null;

  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) sum += Math.abs(ch[start + i]);
    const e = sum / hop;
    env[f] = Math.max(0, e - prev);
    prev = e;
  }

  const minLag = Math.floor((60 * envRate) / 180);
  const maxLag = Math.ceil((60 * envRate) / 60);
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let f = lag; f < frames; f++) score += env[f] * env[f - lag];
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return null;

  let bpm = (60 * envRate) / bestLag;
  let lag = bestLag;
  while (bpm < 85) {
    bpm *= 2;
    lag /= 2;
  }
  while (bpm > 175) {
    bpm /= 2;
    lag *= 2;
  }

  const lagI = Math.round(lag);
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let phase = 0; phase < lagI; phase++) {
    let score = 0;
    for (let f = phase; f < frames; f += lagI) score += env[f];
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  return { bpm: Math.round(bpm * 10) / 10, firstBeat: bestPhase / envRate, interval: 60 / bpm };
}

export function analyzeTrack(buffer: AudioBuffer): TrackAnalysis {
  const beatgrid = detectBeatgrid(buffer);
  return { bpm: beatgrid?.bpm ?? null, beatgrid, pyramid: computePyramid(buffer) };
}

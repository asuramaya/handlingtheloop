// Offline analysis run once per loaded track: waveform peaks for drawing, and a
// coarse BPM estimate via onset-energy autocorrelation. This is a pragmatic
// first pass — good enough to draw a waveform and seed a tempo display. A real
// beatgrid (phase-aligned downbeats) is a later pass.

export interface Peak {
  min: number;
  max: number;
}

export interface TrackAnalysis {
  peaks: Peak[];
  bpm: number | null;
}

/** Downsample to `buckets` min/max peaks across the whole track (mono mix). */
export function computePeaks(buffer: AudioBuffer, buckets = 1600): Peak[] {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = ch0.length;
  const size = Math.max(1, Math.floor(n / buckets));
  const peaks: Peak[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    const end = Math.min(n, start + size);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    peaks.push({ min, max });
  }
  return peaks;
}

/**
 * Coarse BPM estimate. Builds an onset-strength envelope (rectified energy
 * difference) at ~100 Hz, then autocorrelates over the 60–180 BPM lag range and
 * picks the strongest periodicity.
 */
export function estimateBpm(buffer: AudioBuffer): number | null {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);

  const envRate = 100; // Hz
  const hop = Math.floor(sr / envRate);
  if (hop < 1) return null;

  const frames = Math.floor(ch.length / hop);
  if (frames < envRate * 4) return null; // need a few seconds of audio

  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) sum += Math.abs(ch[start + i]);
    const e = sum / hop;
    env[f] = Math.max(0, e - prev); // positive energy flux = onset strength
    prev = e;
  }

  const minBpm = 60;
  const maxBpm = 180;
  const minLag = Math.floor((60 * envRate) / maxBpm);
  const maxLag = Math.ceil((60 * envRate) / minBpm);

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
  // Fold into a typical DJ range so half/double-time estimates land sensibly.
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

export function analyzeTrack(buffer: AudioBuffer): TrackAnalysis {
  return { peaks: computePeaks(buffer), bpm: estimateBpm(buffer) };
}

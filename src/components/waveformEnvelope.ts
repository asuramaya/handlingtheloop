// The pixel → LOD-bucket mapping, lifted out of WaveformViewport so it can be measured.
//
// ★ WHY IT IS OUT HERE. Thread f2b8f545, from the operator's own 2026-09-15 report: "rendering
// artifacts in the viewport where the drawing seems to be collapsing on some of the stems, breaking
// continuity". The mechanism proposed there is in this file — the sub-bucket branch zero-fills any
// pixel whose bucket coordinate lands outside the envelope, and a zero-filled span draws as a FLAT
// TRACE. Zero is the CORRECT answer genuinely past the end of the data; it is a bug only if it
// fires mid-track. That distinction is not readable by eye, so the function moved somewhere a test
// can ask it.
import type { Pyramid, PyramidLevel } from "@htl/analysis";

// The coarsest LOD level whose bucket still fits within `spp` samples-per-pixel (so each
// pixel averages ≥1 bucket → no upsampling). Levels are ordered finest→coarsest.
export function pickLevel(py: Pyramid, spp: number): PyramidLevel {
  let lvl = py.levels[0];
  for (const l of py.levels) {
    if (l.bucket <= spp) lvl = l;
    else break;
  }
  return lvl;
}

// Fill loOut/hiOut[0..ow) with the per-pixel signed envelope of ONE mono signal — the
// SAME representation at every zoom, so there is no style switch across LOD levels:
//   • each pixel reports [lo, hi] = the min/max of the signal it covers, CLAMPED to
//     include the centre (lo ≤ 0 ≤ hi). Filling centre→lo and centre→hi therefore always
//     straddles the axis: zoomed out it reads as the usual amplitude envelope; zoomed in
//     it resolves into the actual signed waveform (the wave fills up for +, down for −).
//   • below one sample/pixel it linearly interpolates between the pixel's two edges, so
//     the trace keeps resolving smoothly all the way down to individual samples (Ableton).
// Source: a precomputed LOD level when zoomed out (cheap), else raw PCM.
export function envelope(
  ch0: Float32Array | null,
  ch1: Float32Array | null,
  chSr: number,
  rLeft: number,
  secPerPx: number,
  ow: number,
  loOut: Float32Array,
  hiOut: Float32Array,
  lod: PyramidLevel | null,
): void {
  const spp = secPerPx * chSr;
  if (lod) {
    const B = lod.bucket;
    const n = lod.min.length;
    // Sub-bucket zoom with no finer LOD and no raw PCM to fall back on — i.e. a host's
    // COARSE remote stem view on a guest (only the ~2048-sample envelope exists). The
    // bucket-min/max loop below would paint each bucket as a flat block across the
    // several pixels it spans, which reads as a "low-poly"/staircase stem. Interpolate
    // the min/max between adjacent buckets instead, so the trace is a smooth curve.
    if (spp < B) {
      for (let x = 0; x < ow; x++) {
        const c = ((rLeft + x * secPerPx) * chSr) / B; // fractional bucket coordinate
        if (c < 0 || c >= n) {
          loOut[x] = 0;
          hiOut[x] = 0;
          continue;
        }
        const b = Math.floor(c);
        const f = c - b;
        const b2 = b + 1 >= n ? b : b + 1;
        loOut[x] = lod.min[b] + (lod.min[b2] - lod.min[b]) * f;
        hiOut[x] = lod.max[b] + (lod.max[b2] - lod.max[b]) * f;
      }
      return;
    }
    for (let x = 0; x < ow; x++) {
      const s0 = (rLeft + x * secPerPx) * chSr;
      let b0 = Math.floor(s0 / B);
      let b1 = Math.floor((s0 + spp) / B);
      if (b1 < 0 || b0 >= n) {
        loOut[x] = 0;
        hiOut[x] = 0;
        continue;
      }
      if (b0 < 0) b0 = 0;
      if (b1 >= n) b1 = n - 1;
      let lo = 0; // clamp to centre so the fill always straddles the axis
      let hi = 0;
      for (let b = b0; b <= b1; b++) {
        if (lod.min[b] < lo) lo = lod.min[b];
        if (lod.max[b] > hi) hi = lod.max[b];
      }
      loOut[x] = lo;
      hiOut[x] = hi;
    }
    return;
  }
  if (!ch0) return;
  const N = ch0.length;
  const at = (i: number) => (ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]);
  const interp = (c: number) => {
    if (c < 0) c = 0;
    else if (c > N - 1) c = N - 1;
    const i = Math.floor(c);
    return at(i) + (at(Math.min(N - 1, i + 1)) - at(i)) * (c - i);
  };
  for (let x = 0; x < ow; x++) {
    const a = (rLeft + x * secPerPx) * chSr;
    if (spp < 1) {
      // Sub-sample: the pixel spans <1 sample → take the segment between its two edges,
      // so consecutive pixels chain into a continuous line down to the sample level.
      const s0 = interp(a);
      const s1 = interp(a + spp);
      loOut[x] = Math.min(0, s0, s1);
      hiOut[x] = Math.max(0, s0, s1);
    } else {
      let i0 = Math.floor(a);
      let i1 = Math.floor(a + spp);
      if (i1 <= i0) i1 = i0 + 1;
      if (i0 < 0) i0 = 0;
      if (i1 > N) i1 = N;
      if (i1 <= i0) {
        loOut[x] = 0;
        hiOut[x] = 0;
        continue;
      }
      let lo = 0;
      let hi = 0;
      for (let i = i0; i < i1; i++) {
        const s = at(i);
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      loOut[x] = lo;
      hiOut[x] = hi;
    }
  }
}

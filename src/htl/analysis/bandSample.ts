import type { PyramidLevel } from "./analyze";

// ★ HOW A COLUMN'S BAND MIX IS AGGREGATED — and why it is a MEAN, not a max.
//
// One screen column covers one bucket when you are zoomed in and hundreds when you are zoomed
// out. The ENVELOPE aggregates those by max, correctly: you want to see the peak the audio
// reached, and a transient that survives one bucket should still make a spike.
//
// Band SHARES are a different question, and max answers it wrongly. Each band is normalised to
// its own peak (see Pyramid.bandPeaks), so over a wide enough span EVERY band finds a bucket
// near its own maximum — the low band finds a kick, the high band finds a hat — and all three
// columns report ~1. The shares then flatten toward equal, which paints a uniform striped block
// exactly at the zoom level where the overview is supposed to tell you where the drop is. The
// colour stops carrying information precisely when you most need it.
//
// A mean is the physically right reduction for "how much of this span was this band": energy
// over a window averages, it does not peak-hold. Zoomed in, where a column is one bucket, mean
// and max are identical — so this changes nothing about the close-up view and only restores
// variation to the far one.

export function sampleBands(
  lod: PyramidLevel,
  chSr: number,
  rLeft: number,
  secPerPx: number,
  ow: number,
  lowOut: Float32Array,
  midOut: Float32Array,
  highOut: Float32Array,
): void {
  const B = lod.bucket;
  const n = lod.low.length;
  const spp = secPerPx * chSr;
  for (let x = 0; x < ow; x++) {
    const s0 = (rLeft + x * secPerPx) * chSr;
    let b0 = Math.floor(s0 / B);
    let b1 = Math.floor((s0 + spp) / B);
    if (b1 < 0 || b0 >= n) {
      lowOut[x] = 0;
      midOut[x] = 0;
      highOut[x] = 0;
      continue;
    }
    if (b0 < 0) b0 = 0;
    if (b1 >= n) b1 = n - 1;
    let l = 0;
    let m = 0;
    let hgh = 0;
    for (let b = b0; b <= b1; b++) {
      l += lod.low[b];
      m += lod.mid[b];
      hgh += lod.high[b];
    }
    const k = b1 - b0 + 1; // ≥ 1, so the zoomed-in single-bucket case is exactly the value itself
    lowOut[x] = l / k;
    midOut[x] = m / k;
    highOut[x] = hgh / k;
  }
}

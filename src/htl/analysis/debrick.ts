// De-brickwall — extracted from the waveform renderer so it can be tested. Pure: it rewrites
// `lo`/`hi` in place and touches nothing else.
// De-brickwall. A heavily limited ("brick wall") master peaks near full-scale in nearly
// every column, so the min/max envelope flat-tops into a solid block and shape()'s lift
// pins it to the rail. This re-expands LOCAL contrast: a slow bidirectional peak/valley
// follower finds each section's loud ceiling + notch floor, and every column is remapped so
// the local floor→`BASE` and local peak→`TOP·loudness` — stretching whatever micro-dynamics
// exist (transient gaps, kicks) into visible contour, while the ceiling tracks the section's
// macro loudness (×gPeak) so drops/breakdowns still dip. `ABS` mixes back a flat macro
// pedestal so loud passages stay tall. Rewrites lo/hi IN PLACE before shape(); runs once per
// lane at rasterise time (not per frame). Skipped at high zoom where columns resolve real
// wave cycles (no brick to fix, and stretching would distort the true shape).
export const DB_BASE = 0.12; // height a section's notch floor maps to
export const DB_TOP = 0.9; // height a fully-loud section's peaks map to
/** ★ THE PEDESTAL WAS COMPRESSING THE VERY THING THIS EXISTS TO EXPAND.
 *  `out` spans [DB_ABS, 1] of the section's ceiling, so at 0.4 a column at the LOCAL MINIMUM
 *  still rendered at 43% height and the whole local range was squeezed into a 2.25:1 band near
 *  the top. A transform that narrows local dynamics is a compressor, whatever it is called —
 *  measured on the operator's stem deck, turning it on pushed every lane up (drums 44.9→60.8%
 *  ink, bass 91.6→100, vocals 94.1→100) and filled two lanes solid.
 *  The pedestal was there to "keep loud passages tall", and that job now belongs to `loud`,
 *  which multiplies the whole expression — so keeping it as well only costs contrast. Dropped to
 *  a token amount, the range opens from 2.25:1 to roughly 6:1 and quiet columns can actually be
 *  quiet. */
export const DB_ABS = 0.1;
export const DB_TAU_SEC = 1.2; // follower time constant ≈ how long a "section" is
/** ★ HOW MUCH LOCAL RANGE COUNTS AS REAL CONTOUR, as a fraction of the local ceiling.
 *  There are TWO ways to have nothing to expand, and the old absolute threshold only caught one.
 *  A span of exactly zero took a degenerate branch that substituted a constant — a solid block.
 *  A span that is tiny but NON-zero was worse: it passed the check and got stretched to the full
 *  output range, so a 0.5% ripple on a pinned master became full-scale contour — noise amplified
 *  into busy uniform texture, which reads as bricked just as surely as a flat block does.
 *  Both are the same mistake: treating "almost no range" as if it were range. A relative floor
 *  answers both, because the question was always proportional. */
export const DB_MIN_SPAN = 0.06;
/** Below this fraction of the track's own reference, a column is left completely alone.
 *  A stem that has not entered yet, or a bar of real silence, carries the most important thing a
 *  waveform says — "nothing is playing here" — and no amount of contrast recovery is worth
 *  spending that. */
export const DB_SILENT_FRAC = 0.02;
/** ★ ONLY EXPAND WHAT IS ACTUALLY COMPRESSED.
 *  This transform maps each section's [local floor, local ceiling] onto a FIXED output range. On
 *  a pinned master that is exactly the repair wanted. On material that already has range it is
 *  the opposite: a drum stem whose gaps sit at 2% of its kicks arrives at ~45:1 and leaves at
 *  ~6:1, so the gaps between hits fatten into blocks and the lane reads MORE brick-walled than
 *  it did untouched — the operator's report, on the one content where it should have been
 *  harmless. No constant fixes that, because the fault is applying the map at all.
 *  So how pinned a section IS decides how much of the map it gets: `envLo/envHi` is 0 for
 *  percussion and approaches 1 for a limiter, and the result is blended against the untouched
 *  signal by that ratio. Below LO nothing happens; above HI it is the full repair. */
export const DB_COMP_LO = 0.25;
export const DB_COMP_HI = 0.6;
export function debrick(
  lo: Float32Array,
  hi: Float32Array,
  ow: number,
  secPerPx: number,
  trackPeak: number,
  /** ★ THE CONTRAST SOURCE, and the whole point of this function working at all.
   *  Read from the PEAK envelope, a brick-walled master has no contour to expand — that is what
   *  "brick-walled" MEANS. `envHi` and `envLo` converge, `span` collapses, every column takes the
   *  degenerate branch, and the output is a constant: switching de-brickwall ON made the loudest
   *  passages FLATTER than leaving it off. It was reading the one measure limiting destroys.
   *  Loudness that survives limiting lives in ENERGY, not peak: a kick still carries far more
   *  than a hat when both peak at 0 dBFS. The pyramid already stores exactly that — its band
   *  values are `sqrt(sum/count)`, RMS per bucket (analyze.ts) — so when the caller can supply
   *  that curve, the followers run on it and there is real contour to find. Optional: without it
   *  the peak envelope is used, which is the old behaviour and still correct for a dynamic master
   *  that genuinely has peak contour. */
  energy?: Float32Array | null,
  /** The track-wide maximum of `energy`, for the same reason trackPeak exists: a reference taken
   *  from the visible window makes the whole thing self-normalising. */
  energyPeak?: number,
): void {
  if (ow < 8) return;
  const src = energy && energy.length >= ow ? energy : null;
  const ref = src ? (energyPeak && energyPeak > 1e-9 ? energyPeak : 0) : trackPeak;
  const m = new Float32Array(ow);
  // ★ THE LOUDNESS REFERENCE IS THE TRACK'S PEAK, NOT THE WINDOW'S. `loud` below is what keeps a
  // breakdown looking like a breakdown — it scales the ceiling by how loud this section is
  // COMPARED TO THE REST OF THE TRACK. Taking that reference from the rendered columns made it
  // self-normalising: the offscreen layer is three viewports wide, so scrolling into a quiet
  // passage until it fills the window made ITS peak the reference, `loud` went to 1, and the
  // breakdown painted at full height — the same audio drawn at a different height depending on
  // where you happened to be looking. That is precisely the "normalises every section to a
  // uniform height band, which reads AS a brick wall" this option ships OFF because of.
  // The pyramid's `max` is a max-tree, so its coarsest level already holds the whole track's
  // peak for free; a caller with no pyramid passes 0 and we fall back to the window (the old
  // behaviour) rather than dividing by nothing.
  let gPeak = ref > 1e-9 ? ref : 1e-9;
  const windowOnly = ref <= 1e-9;
  for (let x = 0; x < ow; x++) {
    m[x] = src ? src[x] : -lo[x] > hi[x] ? -lo[x] : hi[x];
    if (windowOnly && m[x] > gPeak) gPeak = m[x];
  }
  const tau = Math.max(6, Math.min(ow * 0.5, DB_TAU_SEC / Math.max(secPerPx, 1e-6)));
  const decay = Math.exp(-1 / tau);
  const envHi = new Float32Array(ow);
  const envLo = new Float32Array(ow);
  // Forward peak/valley followers: instant attack to a new extreme, one-pole release back.
  let pf = m[0];
  let vf = m[0];
  for (let x = 0; x < ow; x++) {
    pf = m[x] > pf ? m[x] : pf * decay + m[x] * (1 - decay);
    vf = m[x] < vf ? m[x] : vf * decay + m[x] * (1 - decay);
    envHi[x] = pf;
    envLo[x] = vf;
  }
  // ★ "IS THIS BRICK-WALLED?" IS A QUESTION ABOUT THE PEAK, NOT ABOUT THE ENERGY.
  // Brick-walled means the PEAK is flat while the energy underneath still moves — that pairing is
  // the whole diagnosis. Asking it of the energy curve inverts the answer: a limited master has
  // lively energy and would be judged "already dynamic" and left broken, while the drum stem this
  // is meant to spare would be the one repaired. So the pinned-ness test runs its own followers,
  // on the peak envelope, whatever the contrast source happens to be.
  const pm = new Float32Array(ow);
  for (let x = 0; x < ow; x++) pm[x] = -lo[x] > hi[x] ? -lo[x] : hi[x];
  const pHi = new Float32Array(ow);
  const pLo = new Float32Array(ow);
  {
    let a = pm[0];
    let b = pm[0];
    for (let x = 0; x < ow; x++) {
      a = pm[x] > a ? pm[x] : a * decay + pm[x] * (1 - decay);
      b = pm[x] < b ? pm[x] : b * decay + pm[x] * (1 - decay);
      pHi[x] = a;
      pLo[x] = b;
    }
    let c = pm[ow - 1];
    let d = pm[ow - 1];
    for (let x = ow - 1; x >= 0; x--) {
      c = pm[x] > c ? pm[x] : c * decay + pm[x] * (1 - decay);
      d = pm[x] < d ? pm[x] : d * decay + pm[x] * (1 - decay);
      if (c > pHi[x]) pHi[x] = c;
      if (d < pLo[x]) pLo[x] = d;
    }
  }

  // Backward pass, combined → symmetric envelope (no lead/lag bias from the one-pole).
  let pb = m[ow - 1];
  let vb = m[ow - 1];
  for (let x = ow - 1; x >= 0; x--) {
    pb = m[x] > pb ? m[x] : pb * decay + m[x] * (1 - decay);
    vb = m[x] < vb ? m[x] : vb * decay + m[x] * (1 - decay);
    if (pb > envHi[x]) envHi[x] = pb;
    if (vb < envLo[x]) envLo[x] = vb;
  }
  for (let x = 0; x < ow; x++) {
    const a = m[x];
    if (a < 1e-6) continue; // leave true silence alone
    // The height being rewritten is always the PEAK envelope, even when the contrast that drives
    // the rewrite was read from energy — the two answer different questions about the column.
    const peak = -lo[x] > hi[x] ? -lo[x] : hi[x];
    if (peak < 1e-4) continue;
    // Absolute silence gate, relative to the TRACK — not to this window and not to this column's
    // own neighbourhood, both of which would happily decide that near-nothing is locally loud.
    if (a < gPeak * DB_SILENT_FRAC) continue;
    const span = envHi[x] - envLo[x];
    // NO REAL LOCAL CONTOUR → LEAVE THE COLUMN ALONE. Not "assume mid contrast" (which drives
    // every such column to the same height and paints a solid block), and not "expand whatever
    // is there" (which turns a ripple into full-scale texture). Where there is nothing to say,
    // saying nothing means changing nothing. See DB_MIN_SPAN.
    if (span <= envHi[x] * DB_MIN_SPAN || span <= 1e-5) continue;
    let stretched = (a - envLo[x]) / span; // local contrast 0..1
    stretched = stretched < 0 ? 0 : stretched > 1 ? 1 : stretched;
    const loud = envHi[x] / gPeak; // 0..1 macro loudness of this section
    // floor=DB_BASE·(1-ABS) … ceiling=TOP·loud ; texture fills between, pedestal keeps it loud
    // ★ MACRO LOUDNESS GATES THE WHOLE OUTPUT, NOT PART OF IT.
    // This used to read `DB_BASE*(1-DB_ABS) + DB_TOP*loud*(...)`, so the first term was a
    // CONSTANT floor added no matter how quiet the section was: as `loud` went to 0 the height
    // went to 0.072, not to 0. Every non-silent column was lifted to at least 7.2% of the lane,
    // which on a stem sitting at a fraction of a percent of full scale is a ~70x magnification —
    // a vocal stem that had not entered yet rendered as a continuous band across its whole lane,
    // and the one thing that view exists to tell you (which stems are playing) was gone.
    // Multiplying through means a silent section resolves to silence, while the loud end is
    // unchanged: at loud=1, stretched=1 this is still 0.972, exactly as before.
    const out = loud * (DB_BASE * (1 - DB_ABS) + DB_TOP * (DB_ABS + (1 - DB_ABS) * stretched));
    // How PINNED this section is: 0 = wide open (percussion), →1 = flattened by a limiter.
    const pinned = pHi[x] > 1e-9 ? pLo[x] / pHi[x] : 0;
    let mix = (pinned - DB_COMP_LO) / (DB_COMP_HI - DB_COMP_LO);
    mix = mix < 0 ? 0 : mix > 1 ? 1 : mix;
    mix = mix * mix * (3 - 2 * mix); // smoothstep, so sections don't switch abruptly mid-track
    if (mix <= 0) continue; // already dynamic — the best thing this can do is nothing
    const scale = 1 + ((out / peak) - 1) * mix; // blend toward the repair, never past it
    hi[x] *= scale;
    lo[x] *= scale;
  }
}

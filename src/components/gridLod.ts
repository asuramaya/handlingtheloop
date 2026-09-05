// THE BEAT GRID'S LEVEL OF DETAIL — which tiers draw, and how strongly, at a given zoom.
//
// Pulled out of WaveformViewport's draw loop because it is the part that was WRONG and the part
// that cannot be checked by looking at one screenshot: the complaint was "the zoom collapse
// mechanism is a bit lackluster, we end up with these weird in-between states that cover too much
// of the song", and both halves of that are claims about a CURVE over zoom, not about a frame.
// A pure function can be swept.
//
// ★ WHAT WAS WRONG. Every tier was a hard boolean:
//     barStep doubles until pxPerBar * barStep >= 22   → real bar spacing swung 22…44px
//     showBeat = barStep === 1 && pxPerBeat >= 9       → a full-alpha line every 9px, or none
//     showSub  = barStep === 1 && pxPerBeat / subs >= 4
//   So (a) half of every zoom octave put a bold line every ~22px, which is hatching rather than a
//   ruler, and (b) crossing 9px/beat switched a whole tier on at full strength in one frame. The
//   in-between states were not a rendering artefact; they were the design.
//
// Now every tier RAMPS across a band of zoom and the bar tier cross-fades its own next-finer step,
// so what changes as you zoom is density, continuously.

/** Bold structural lines never sit closer than this. A line needs room around it or it stops
 *  being a reference and becomes texture. */
export const MIN_BAR_PX = 64;

export interface GridLod {
  /** Draw a bold line every `barStep` bars. Always a power of two. */
  barStep: number;
  /** Alpha multiplier for the half-step bar lines (the ones that become the bold tier one zoom
   *  level in). 0 when `barStep` is 1 — there is nothing finer to fade in. */
  halfFade: number;
  /** Alpha multiplier for the per-beat lines. */
  beatFade: number;
  /** Alpha multiplier for the sub-beat lines. */
  subFade: number;
  /** Bar numbers are legible at this spacing. */
  showLabels: boolean;
}

const ramp = (v: number, a: number, b: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));

export function gridLod(pxPerBeat: number, beatsPerBar: number, subs: number): GridLod {
  const pxPerBar = pxPerBeat * Math.max(1, beatsPerBar);
  let barStep = 1;
  while (pxPerBar * barStep < MIN_BAR_PX) barStep *= 2;
  return {
    barStep,
    halfFade: barStep > 1 ? ramp(pxPerBar * (barStep / 2), MIN_BAR_PX * 0.5, MIN_BAR_PX) : 0,
    beatFade: ramp(pxPerBeat, 11, 22),
    subFade: subs > 1 ? ramp(pxPerBeat / subs, 5, 11) : 0,
    showLabels: pxPerBar * barStep >= 34,
  };
}

/** Base alphas per tier, before the fades above.
 *
 *  ★ `phrase` LIVES HERE, NOT ON THE MARKER SLIDER. A phrase boundary was drawn at
 *  `markerThickness + 1` px and 0.85 alpha — so at the operator's setting of 4 it was 5px of
 *  near-solid accent, and once the beat grid was cut loose from that same slider the phrase bars
 *  became by far the heaviest thing on the lane: 5.9× a bar line's ink where they should be about
 *  2×. A phrase is DERIVED structure on a continuum with the grid (analysed, one every ~8 bars),
 *  not a point you placed by hand like a cue or a loop, so it follows the grid's weight
 *  discipline and is simply the strongest tier in it. The slider goes back to meaning what it
 *  says: the cue/loop/hot-cue bars. */
export const GRID_ALPHA = { bar: 0.52, beat: 0.22, sub: 0.11, phrase: 0.88 };
/** Line widths in CSS px. Deliberately NOT scaled by the user's `markerThickness`: that setting
 *  sizes the handful of deliberate cue/loop/phrase markers, and using it on a continuous
 *  background made a bold-cues preference into a wall of grid. */
export const GRID_W = { bar: 1.4, beat: 1, sub: 1, phrase: 2.2 };

/** How much of a lane's width the grid actually inks at a given zoom, as a fraction — width times
 *  alpha, summed over the tiers that are drawing, per bar. This is the number the complaint was
 *  about, and the only honest way to say whether a change to the tiers made things better. */
export function gridInk(pxPerBeat: number, beatsPerBar: number, subs: number): number {
  const l = gridLod(pxPerBeat, beatsPerBar, subs);
  const pxPerBar = pxPerBeat * Math.max(1, beatsPerBar);
  // One coarse bar line per `barStep` bars, plus a half-step line in between when it is fading in.
  const span = pxPerBar * l.barStep;
  let ink = GRID_W.bar * GRID_ALPHA.bar; // the coarse line
  if (l.halfFade > 0) ink += GRID_W.bar * GRID_ALPHA.bar * l.halfFade; // one half-step line per span
  const beatsInSpan = beatsPerBar * l.barStep;
  const nonBarBeats = beatsInSpan - 1; // the bar line itself is already counted
  ink += nonBarBeats * GRID_W.beat * GRID_ALPHA.beat * l.beatFade;
  if (l.subFade > 0) ink += beatsInSpan * (subs - 1) * GRID_W.sub * GRID_ALPHA.sub * l.subFade;
  return ink / span;
}

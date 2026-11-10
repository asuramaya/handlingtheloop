// HOW HEAVY THE THINGS DRAWN OVER A WAVEFORM ARE — one object read by the deck waveform and the
// song overview rails, built from Settings ▸ Colours ▸ Markers.
//
// ★ Operator, 2026-11-10: "fix marker thickness like the bar lines and playhead etc, need more
// customization for that. i cant see the difference upping the width/thickness, my problem is that
// in single track no stem mode the markers are very hard to see", and of the overview rails: "the
// markers are not great in terms of visibility and using them is hard specially when they are super
// thin on mobile". The one slider only reached the deck waveform's cue/loop flags; the rails drew
// fixed 1.3 px ticks with 9 px letters, the playhead and the grid were fixed, and every mark was a
// flat colour on a bright full-height mix waveform with nothing to separate it.
import type { Settings } from "@htl/state";

export interface MarkerStyle {
  /** Cue / hot-cue / loop bar width, CSS px (the original slider). */
  thickness: number;
  /** Playhead width, CSS px. */
  playhead: number;
  /** Beat grid weight: multiplies the grid's line widths and (above 1) its opacity. */
  grid: number;
  /** A thin dark edge either side of markers and the playhead, so they read over a bright wave. */
  outline: boolean;
  /** Overview rail markers: ticks, letters, label boxes and the tap target, as one scale. */
  overview: number;
}

export const DEFAULT_MARKER_STYLE: MarkerStyle = { thickness: 2, playhead: 2, grid: 1, outline: true, overview: 1 };

export function markerStyleOf(s: Settings): MarkerStyle {
  return {
    thickness: s.markerThickness ?? 2,
    playhead: s.playheadWidth ?? 2,
    grid: s.gridWeight ?? 1,
    outline: s.markerOutline ?? true,
    overview: s.overviewMarkerScale ?? 1,
  };
}

/** The dark edge drawn under a mark (see `outline`). */
export const MARK_EDGE = "rgba(4,6,10,0.85)";

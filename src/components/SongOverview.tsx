import { useEffect, useRef, useState } from "react";
import type { Deck } from "@htl/audio";
import type { Pyramid, PyramidLevel } from "@htl/analysis";
import type { TrackMeta } from "@htl/library";
import { hexRGB, bandRamp, tiltLuma, sampleBands, debrick } from "@htl/analysis";
import { CUE_COLORS, trackPeak, trackEnergyPeak, shape, BAND_TILT } from "./WaveformViewport";
import { TRACK_DND_MIME } from "./TrackTable";
import { useTouchDropTarget } from "../htl/state/touchDrag";
import { LABEL_BOX_PX, MARKER_SNAP_PX, labelsShareColumn, hitMarker, insetMark, laneRect, loopIsCollapsed, markerLane, markerPriority, overviewSeekTime, resolveLabels, type OverviewMarker } from "./overviewSeek";

// ★ THE REKORDBOX "OVERVIEW" STRIP — but VERTICAL, one per deck, running the full height of
// the stacked pair and sitting at the OUTER edge (Deck A → left, Deck B → right; see `side`),
// so the two rails bookend the board instead of colliding at the mixer in the middle. Time
// runs top (track start) → bottom (track end).
//
// Unlike WaveformViewport this is ALWAYS maximally zoomed out — the whole track compressed
// into whatever device-pixel height the lane has — so none of that component's zoom/scroll/
// LOD-picking machinery applies. Colour grammar (flat tri-band tint OR the layered/rekordbox-
// style stacked lobes, same BAND_TILT balance correction, same `shape()` amplitude curve) IS
// shared with WaveformViewport though — a rotated overview is still supposed to look like a
// waveform from the SAME deck, not a different renderer's idea of one.
//
// STATIC layer (waveform + loop tint + markers) is rasterised ONCE per track/resize/settings
// change into an offscreen canvas — not recomputed every animation frame — with only the
// playhead + viewport-ghost redrawn live on top. That matters more here than it first looks:
// de-brickwalling + layered-band math is real per-row work, and this strip repaints at 60fps
// during playback like every other on-screen waveform.

interface SongOverviewProps {
  deck: Deck;
  pyramid: Pyramid | null; // mix LOD (stable per track) — same one WaveformViewport gets
  accent: string;
  background: string;
  selectorColor: string;
  /** The GRID/divider colour, the same one the main waveform's beat grid uses. Phrase boundaries
   *  take it, so they read against a deck-coloured waveform instead of dissolving into it. */
  markerColor: string;
  loopColor: string;
  freqColors: boolean;
  freqLow: string;
  freqMid: string;
  freqHigh: string;
  vividness: number;
  bandLayers: boolean; // same setting WaveformViewport reads — layered lobes vs. flat tint
  bandFromDeck: boolean;
  side: "left" | "right"; // which edge this rail sits on — also which side its cue labels open toward
  windowSec: number; // the main waveform's zoom width, in real seconds — for the viewport ghost
  locked: boolean; // watch-only session: no click-to-seek
  onSeek?: (position: number) => void;
  refresh: () => void;
  // Drop target, same as the main lane: drag a library/search row (TRACK_DND_MIME) or an audio
  // file straight onto this rail to load it to this deck — you shouldn't have to aim for the
  // (on mobile, much smaller) main waveform specifically when this rail is right there too.
  onLoadFile?: (file: File) => void;
  onLoadTrack?: (track: TrackMeta) => void;
  // Touching/dragging this rail focuses its deck — the same "which deck am I controlling"
  // switch a touch on the main waveform already does (DeckLane's onFocus), so reaching for
  // either waveform (main or overview) has the same effect.
  onFocus?: () => void;
}

const MAX_DPR = 2;
// The click snap radius moved to overviewSeek.ts with the mapping it belongs to — and became a
// PRESS-only affordance there. It used to apply to drags as well, which is what made them coarse.
// Below this CSS width the layered-lobe render (three stacked ribbons, more line work,
// wants room to read) falls back to the simpler flat tint — same rule WaveformViewport's
// LAYER_MIN_LANE applies to its own stem lanes.
const LAYER_MIN_WIDTH = 90;

// hex → rgba() at alpha; mirrors WaveformViewport's own helper (kept local, it's one line).
function rgba(hex: string, a: number): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
/** The same colour at full strength. A tick's LINE can be translucent — it lies over the
 *  waveform and wants to read as a rule, not a wall — but its LETTER cannot: at 9px, thin
 *  strokes at 0.7-0.95 alpha over a bright waveform are the "dim and transparent, hard to read"
 *  the operator saw. Ink is ink; only the line is a wash. */
function opaque(color: string): string {
  const m = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (!m) return color; // a bare hex is already opaque
  const [r, g, b] = m[1].split(",").map((v) => parseFloat(v));
  return `rgb(${cl(r)}, ${cl(g)}, ${cl(b)})`;
}
const cl = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// The coarsest LOD level whose bucket still fits within `spp` samples-per-row — mirrors
// WaveformViewport's own pickLevel. ★ NOT just `py.levels[levels.length-1]`: the pyramid's
// build loop halves buckets until exactly ONE bucket is left (trackPeak's O(1) global-extremes
// level), so reading the true last level directly collapses every row to the SAME global
// min/max — a flat, full-amplitude block for the whole track instead of a shape. Even a
// multi-minute track squeezed into a few hundred rows wants the coarsest level that still has
// enough buckets to vary row-to-row, which is one or two steps short of that degenerate top.
function pickLevel(py: Pyramid, spp: number): PyramidLevel {
  let lvl = py.levels[0];
  for (const l of py.levels) {
    if (l.bucket <= spp) lvl = l;
    else break;
  }
  return lvl;
}

// Envelope (signed min/max) sampled by ROW instead of by column — the same bucket-averaging
// shape as WaveformViewport's own `envelope()`, minus the raw-PCM / sub-bucket branches this
// never needs (a whole track squeezed into a few hundred rows is always coarser than the
// finest LOD bucket).
function sampleEnvelope(lod: PyramidLevel, chSr: number, secPerRow: number, rows: number, loOut: Float32Array, hiOut: Float32Array) {
  const B = lod.bucket;
  const n = lod.min.length;
  const spp = secPerRow * chSr;
  for (let y = 0; y < rows; y++) {
    const s0 = y * spp;
    let b0 = Math.floor(s0 / B);
    let b1 = Math.floor((s0 + spp) / B);
    if (b1 < 0 || b0 >= n) {
      loOut[y] = 0;
      hiOut[y] = 0;
      continue;
    }
    if (b0 < 0) b0 = 0;
    if (b1 >= n) b1 = n - 1;
    let lo = 0;
    let hi = 0;
    for (let b = b0; b <= b1; b++) {
      if (lod.min[b] < lo) lo = lod.min[b];
      if (lod.max[b] > hi) hi = lod.max[b];
    }
    loOut[y] = lo;
    hiOut[y] = hi;
  }
}

interface Marker extends OverviewMarker {
  label: string;
  color: string;
  thickness: number;
}

export function SongOverview(props: SongOverviewProps) {
  const { deck, side, locked, refresh, onSeek, onLoadFile, onLoadTrack, onFocus } = props;
  const [dropActive, setDropActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Touch drag-and-drop — the native onDrop/onDragOver below only ever fires for a MOUSE drag
  // (no touchscreen browser implements HTML5 DnD for touch); this is the touch equivalent, fed
  // by TrackTable's long-press-then-move gesture. Same visual cue (dropActive), same effect
  // (onLoadTrack with the first dragged track — matching the native onDrop's own tie-break).
  useTouchDropTarget(
    canvasRef,
    (tracks) => {
      if (tracks[0] && onLoadTrack) onLoadTrack(tracks[0]);
    },
    setDropActive,
  );
  const layerRef = useRef<HTMLCanvasElement | null>(null); // offscreen: waveform + loop + markers
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const staleRef = useRef(true); // the OFFSCREEN layer needs a rebuild
  const dirty = useRef(true); // the on-screen composite needs a blit (every frame while playing)
  const markersRef = useRef<Marker[]>([]); // last-rasterised marker list, for click-to-seek snapping
  // At most one parent re-render per FRAME while a drag is running (see applySeek).
  // Which marker the pointer is currently inside the snap zone of, as an index into markersRef —
  // a REF, not state, because it changes on every mouse move and the rail already has its own rAF
  // (`dirty`). Putting it in state would re-render the whole board to move a highlight, which is
  // the exact cost the drag had to be rescued from one ruling ago.
  const hoverRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const refreshRaf = useRef(0);
  const lastEmit = useRef(0);
  const moved = useRef(false); // did this gesture actually drag, or was it a click?
  // Which kind of pointer is driving RIGHT NOW — not a media query, because a laptop with a
  // touchscreen is both, and what matters is the finger that is actually on the glass.
  const coarseRef = useRef(false);
  const queueRefresh = () => {
    if (refreshRaf.current) return;
    refreshRaf.current = requestAnimationFrame(() => {
      refreshRaf.current = 0;
      refresh();
    });
  };
  useEffect(() => () => { if (refreshRaf.current) cancelAnimationFrame(refreshRaf.current); }, []);
  const view = useRef(props);
  view.current = props;
  dirty.current = true;
  staleRef.current = true; // any render (track load, theme, cue edit…) → rebuild the static layer once

  const measure = () => {
    const el = canvasRef.current;
    if (!el) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    sizeRef.current = { w, h, dpr };
    staleRef.current = true;
    dirty.current = true;
    draw();
  };

  useEffect(() => {
    measure();
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.pyramid,
    props.accent,
    props.background,
    props.selectorColor,
    props.markerColor,
    props.loopColor,
    props.freqColors,
    props.freqLow,
    props.freqMid,
    props.freqHigh,
    props.vividness,
    props.bandLayers,
    props.bandFromDeck,
    props.side,
  ]);

  // Rebuild the STATIC layer: background, waveform (flat tint or layered lobes — the same
  // colour grammar WaveformViewport uses), loop tint, and cue/hot-cue/phrase markers. Runs
  // only when staleRef is set (track/settings/resize), never per animation frame.
  const rasterizeStatic = () => {
    const { w, h, dpr } = sizeRef.current;
    if (w < 1 || h < 1) return;
    let layer = layerRef.current;
    if (!layer) {
      layer = document.createElement("canvas");
      layerRef.current = layer;
    }
    if (layer.width !== w || layer.height !== h) {
      layer.width = w;
      layer.height = h;
    }
    const ctx = layer.getContext("2d");
    if (!ctx) return;
    const p = view.current;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, w, h);

    const py = p.pyramid;
    const dur = deck.duration;
    // The hover is an INDEX into the list about to be replaced. A new track, an edited cue or a
    // resize rebuilds it, and a surviving index would either point at nothing (highlight silently
    // gone) or — worse — at a different marker, lighting up something the pointer is nowhere near.
    hoverRef.current = null;
    markersRef.current = [];
    if (!py || !py.levels.length || !(dur > 0)) return;
    const chSr = py.sampleRate;
    const secPerRow = dur / h;
    const lod = pickLevel(py, secPerRow * chSr);

    const lo = new Float32Array(h);
    const hi = new Float32Array(h);
    sampleEnvelope(lod, chSr, secPerRow, h, lo, hi);
    // De-brickwall: a peak-only envelope on a modern, heavily-limited master is a flat slab
    // with no contour (that IS what "brick-walled" means). Same fix WaveformViewport uses:
    // read the RMS band-energy curve (survives limiting even where the peak doesn't) as the
    // contrast source and re-expand lo/hi from it.
    const lb0 = new Float32Array(h);
    const mb0 = new Float32Array(h);
    const hb0 = new Float32Array(h);
    sampleBands(lod, chSr, 0, secPerRow, h, lb0, mb0, hb0);
    const bpE = py.bandPeaks ?? [1, 1, 1];
    const energy = new Float32Array(h);
    for (let y = 0; y < h; y++) energy[y] = lb0[y] * bpE[0] + mb0[y] * bpE[1] + hb0[y] * bpE[2];
    debrick(lo, hi, h, secPerRow, trackPeak(py), energy, trackEnergyPeak(py));

    const mixRaw: [[number, number, number], [number, number, number], [number, number, number]] = p.bandFromDeck
      ? bandRamp(p.accent)
      : [hexRGB(p.freqLow), hexRGB(p.freqMid), hexRGB(p.freqHigh)];
    const mixFlat = p.bandFromDeck ? mixRaw : tiltLuma(mixRaw);
    const midX = w / 2;
    const amp = w / 2 - 1 * dpr;
    // `shape()` is WaveformViewport's soft-knee amplitude curve — same reason it uses it: a
    // linear envelope makes quiet passages invisible and loud ones a flat wall, which is half
    // of what "doesn't look like a waveform" meant. Same curve here keeps the two views reading
    // as the same instrument at a glance, not two different artists' idea of a waveform.
    const shHi = new Float32Array(h);
    const shLo = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      shHi[y] = shape(hi[y]);
      shLo[y] = shape(lo[y]);
    }

    const useLayers = p.bandLayers && p.freqColors && w >= LAYER_MIN_WIDTH * dpr;
    if (useLayers) {
      // ---- layered/rekordbox-style stacked lobes: high innermost, low outermost, tiling
      // the row's amplitude exactly (nothing hidden behind anything, nothing sums to white) —
      // ported from WaveformViewport's paintLayered, rotated column→row. ----
      const bp = bpE;
      const wL = Math.pow(bp[0], BAND_TILT), wM = Math.pow(bp[1], BAND_TILT), wH = Math.pow(bp[2], BAND_TILT);
      const pk = new Float32Array(h); // boundary 1: high occupies [0, pk]
      const cum = new Float32Array(h); // boundary 2: mid occupies [pk, cum]; low takes [cum, 1]
      for (let y = 0; y < h; y++) {
        const l = lb0[y] * wL, m = mb0[y] * wM, hgh = hb0[y] * wH;
        const sum = l + m + hgh;
        if (sum <= 1e-6) continue;
        pk[y] = hgh / sum;
        cum[y] = (hgh + m) / sum;
      }
      const viv = p.vividness;
      const bands: Array<[number, [number, number, number]]> = [
        [0, mixFlat[2]],
        [1, mixFlat[1]],
        [2, mixFlat[0]],
      ];
      for (const [si, col] of bands) {
        let [rf, gf, bf] = col;
        if (viv !== 1) {
          const gray = 0.299 * rf + 0.587 * gf + 0.114 * bf;
          rf = gray + (rf - gray) * viv;
          gf = gray + (gf - gray) * viv;
          bf = gray + (bf - gray) * viv;
        }
        ctx.fillStyle = `rgb(${cl(rf)},${cl(gf)},${cl(bf)})`;
        for (let y = 0; y < h; y++) {
          const innerAt = si === 0 ? 0 : si === 1 ? pk[y] : cum[y];
          const outerAt = si === 0 ? pk[y] : si === 1 ? cum[y] : 1;
          const hiA = shHi[y] * amp, loA = shLo[y] * amp;
          const x0 = midX + hiA * innerAt, x1 = midX + hiA * outerAt;
          if (Math.abs(x1 - x0) > 0.1) ctx.fillRect(Math.min(x0, x1), y, Math.max(0.5, Math.abs(x1 - x0)), 1);
          const x2 = midX + loA * innerAt, x3 = midX + loA * outerAt;
          if (Math.abs(x3 - x2) > 0.1) ctx.fillRect(Math.min(x2, x3), y, Math.max(0.5, Math.abs(x3 - x2)), 1);
        }
      }
    } else if (p.freqColors) {
      // ---- flat tri-band tint: one blended colour per row, same BAND_TILT balance
      // correction WaveformViewport's own flat (non-layered) mode applies. ----
      const wL = Math.pow(bpE[0], BAND_TILT), wM = Math.pow(bpE[1], BAND_TILT), wH = Math.pow(bpE[2], BAND_TILT);
      const [cL, cM, cH] = mixFlat;
      const viv = p.vividness;
      let lastKey = -1;
      for (let y = 0; y < h; y++) {
        const l = lb0[y] * wL, m = mb0[y] * wM, hgh = hb0[y] * wH;
        const sum = l + m + hgh + 1e-4;
        let rf = (l * cL[0] + m * cM[0] + hgh * cH[0]) / sum;
        let gf = (l * cL[1] + m * cM[1] + hgh * cH[1]) / sum;
        let bf = (l * cL[2] + m * cM[2] + hgh * cH[2]) / sum;
        if (viv !== 1) {
          const gray = 0.299 * rf + 0.587 * gf + 0.114 * bf;
          rf = gray + (rf - gray) * viv;
          gf = gray + (gf - gray) * viv;
          bf = gray + (bf - gray) * viv;
        }
        const r = cl(rf) & 0xf8, g = cl(gf) & 0xf8, b = cl(bf) & 0xf8;
        const key = (r << 16) | (g << 8) | b;
        if (key !== lastKey) {
          ctx.fillStyle = `rgba(${r},${g},${b},0.96)`;
          lastKey = key;
        }
        const left = Math.max(1, shHi[y] * amp - shLo[y] * amp);
        ctx.fillRect(midX + shLo[y] * amp, y, left, 1);
      }
    } else {
      ctx.fillStyle = rgba(p.accent, 0.85);
      for (let y = 0; y < h; y++) {
        const left = Math.max(1, shHi[y] * amp - shLo[y] * amp);
        ctx.fillRect(midX + shLo[y] * amp, y, left, 1);
      }
    }
    // A thin bright centre spine — the axis a rotated waveform otherwise lacks, same role
    // the zero-line plays in the main waveform.
    ctx.fillStyle = rgba(p.accent, 0.9);
    ctx.fillRect(midX - 0.5 * dpr, 0, 1 * dpr, h);

    // ---- markers: loop / cue / hot cues / phrases, compact ticks that open INWARD (toward
    // the waveform) for cues, OUTWARD (toward the app's edge) for phrases, so the families
    // never collide on a dense track. Each one is ALSO recorded to markersRef for the
    // click-to-seek snap below — "special click zones that skip to them precisely". ----
    ctx.font = `bold ${9 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = "middle";

    const marks: Marker[] = [];
    // ★ TWO LANES, NOT ONE. Every family used to draw a FULL-WIDTH tick and only the LABELS were
    // kept apart (cues inward, phrases outward) — so on a dense track the ticks themselves were
    // one indistinguishable comb and a hot cue landing on a phrase boundary simply vanished under
    // it. Sections get the half nearest the app edge (where their labels already open), cues and
    // loop edges the half nearest the waveform (likewise). Nothing overlaps because nothing
    // shares a column any more.
    // ★ THE LABEL SITS IN A GAP IN ITS OWN LINE, NOT IN A BLOCK ACROSS THE RAIL. It used to be a
    // 12px opaque slab pinned to the FAR edge — a chubby brick facing a thin tick, two objects
    // for one marker, and the heaviest thing on a rail whose job is to show a waveform. Now the
    // tick is a thin line that grows out of the marker's OWN side and simply breaks in the middle
    // to let the letter through, the way a dimension line carries its measurement. The break is
    // the clearance, so there is no backing plate at all.
    const drawTick = (y: number, color: string, label: string, thickness: number, kind: Marker["kind"]) => {
      const lane = laneRect(kind, side, w);
      // insetMark, not `y - thickness/2`: a marker at t=0 or t=duration is centred on the very
      // edge, so half of it lands outside the canvas and reads as a clipped rail. A LABELLED mark
      // is as tall as its letter, not as tall as its line — inset by the glyph's box or the top
      // one still loses half its "A".
      const box = (label ? LABEL_BOX_PX : thickness) * dpr;
      const cy = insetMark(y, box, h) + box / 2;
      const top = cy - (thickness * dpr) / 2;
      ctx.fillStyle = color;
      if (!label) {
        ctx.fillRect(lane.x, top, lane.w, thickness * dpr);
        return;
      }
      // ★ THE TICK KEEPS ITS LANE; THE LABEL MAY NEED THE WHOLE RAIL. At the mobile rail's 32px a
      // lane is 16px, and a one-character gap of 14px left 1px of line per side — a letter
      // floating in nothing. Which half the tick grows from still names the family (a tick is
      // 1.3px and always fits); only the glyph box widens, and resolveLabels is told they now
      // share one column so a section and a cue cannot overprint each other.
      const labelBox = shareCol ? { x: 0, w } : lane;
      const gap = label.length * 6.5 * dpr + 7 * dpr;
      const gx = labelBox.x + (labelBox.w - gap) / 2;
      // The line is this mark's own lane MINUS whatever the gap covers of it — the gap can now
      // straddle the seam, so "left piece, right piece" has to be computed against the lane.
      const l0 = lane.x;
      const l1 = lane.x + lane.w;
      ctx.fillRect(l0, top, Math.max(0, Math.min(gx, l1) - l0), thickness * dpr);
      ctx.fillRect(Math.max(gx + gap, l0), top, Math.max(0, l1 - Math.max(gx + gap, l0)), thickness * dpr);
      // ★ THE LETTER GETS A HALO, NOT A BLOCK — and full ink. The gap puts the glyph over the
      // WAVEFORM, not over black, so a 0.95-alpha near-white letter at 9px was sitting on bright
      // yellow with almost no contrast: "dim and transparent, hard to read". A short dark stroke
      // behind it buys the separation the removed slab used to, at the cost of ~1px around each
      // glyph instead of a 12px brick, and the fill goes to full opacity.
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = "rgba(4,6,10,0.9)";
      const lcx = (shareCol ? 0 : lane.x) + (shareCol ? w : lane.w) / 2;
      ctx.strokeText(label, lcx, cy);
      ctx.fillStyle = opaque(color);
      ctx.fillText(label, lcx, cy);
    };
    // ★ COLLECT NOW, DRAW ONCE. Marks used to paint as they were produced, which made a label's
    // fate depend on the order the draw loop happened to reach it in — and made it impossible to
    // ask "is anything already occupying this glyph's space?", because the answer changed
    // depending on where you asked from. Everything is gathered first; resolveLabels then settles
    // the whole lane at once.
    const shareCol = labelsShareColumn(w / dpr);
    const tick = (t: number, color: string, label: string | undefined, thickness: number, kind: Marker["kind"]) => {
      if (t < 0 || t > dur) return;
      marks.push({ t, kind, label: label ?? "", color, thickness });
    };
    // ---- loop: tinted span + bright IN/OUT edge ticks (registered for the click-snap same
    // as any other marker — "gotta add support for loops"). Drawn BEFORE the other markers so
    // a cue/hot-cue/phrase tick sitting exactly on a loop edge still paints on top of it. ----
    const loop = deck.loop;
    if (loop && loop.end > loop.start) {
      const y0 = (loop.start / dur) * h;
      const y1 = (loop.end / dur) * h;
      // The tint belongs to the same lane as its own IN/OUT ticks. Full-width, it was the one
      // thing still crossing the seam — a band lying over both columns while its edges sat in
      // one, which reads as two unrelated marks rather than one region.
      const ll = laneRect("loop", side, w);
      ctx.fillStyle = rgba(p.loopColor, loop.active ? 0.28 : 0.14);
      ctx.fillRect(ll.x, y0, ll.w, Math.max(1, y1 - y0));
      // A region too small to BE a region is a point — see loopIsCollapsed. One tick, one label,
      // one snap target, so the two edges cannot overprint each other or race for the same pixel.
      if (loopIsCollapsed(y0, y1)) {
        tick(loop.start, rgba(p.loopColor, 0.95), "\u21bb", 1.6, "loop"); // ↻, the glyph the saved-loop PAD wears
      } else {
        tick(loop.start, rgba(p.loopColor, 0.95), "\u25b6", 1.6, "loop"); // ▶, as the main waveform flags it
        tick(loop.end, rgba(p.loopColor, 0.95), "\u25c0", 1.6, "loop"); // ◀, likewise
      }
    }
    // Phrases (verse/build/drop/breakdown structure) — bolder + labelled with the rekordbox-style
    // repeat-section letter (a repeated section reuses its earlier letter; falls back to a bare
    // P-number for an older-format cached grid with no phraseLabels yet).
    const phrases = deck.beatgrid?.phrases;
    const phraseLabels = deck.beatgrid?.phraseLabels;
    if (phrases) {
      for (let i = 0; i < phrases.length; i++) {
        // ★ THE GRID'S COLOUR, NOT THE DECK'S. A phrase boundary was drawn in the deck accent —
        // the same hue as the waveform behind it — so on a busy section it dissolved into the
        // very picture it is meant to divide. The operator offered the PLAYHEAD's colour or the
        // dividers'; it takes the dividers'. The playhead is the one thing on this rail that
        // means "you are HERE, now", and it moves — lending its colour to a dozen static lines
        // would make two different things look identical, which is the failure this whole pass
        // has been about. Phrases are already the strongest tier of the beat grid by WEIGHT
        // (gridLod.ts); this makes them the strongest tier by colour too, which is the same
        // statement said once instead of twice.
        tick(phrases[i], rgba(p.markerColor, 0.95), phraseLabels?.[i] ?? `P${i + 1}`, 1.6, "phrase");
      }
    }
    // ★ SAVED LOOPS (pads 1-8) ARE ON THE RAIL TOO. They share the pad slots with hot cues —
    // `slotIsSet` is either-or — so a rail that drew hot cues and not saved loops was showing you
    // half of your own pad bank and silently hiding the other half. A saved loop is a REGION, so
    // it gets what a region needs: a tinted span for its extent, a labelled tick at its IN (the
    // edge you actually jump to) and a plain one at its OUT. Same pad colour as the pad itself,
    // so the rail and the bank read as one set.
    deck.hotLoops.forEach((l, i) => {
      if (!l || !(l.end > l.start)) return;
      const c = CUE_COLORS[i % CUE_COLORS.length];
      const lane = laneRect("sloop", side, w);
      const y0 = (l.start / dur) * h;
      const y1 = (l.end / dur) * h;
      ctx.fillStyle = rgba(c, 0.16);
      ctx.fillRect(lane.x, y0, lane.w, Math.max(1, y1 - y0));
      tick(l.start, c, String(i + 1), 1.3, "sloop");
      // Same collapse rule: a saved loop shorter than its own label has no second edge worth
      // drawing, and an unlabelled tick a pixel away from a labelled one is just noise you
      // cannot aim at.
      if (!loopIsCollapsed(y0, y1)) tick(l.end, rgba(c, 0.7), undefined, 1, "sloop");
    });
    if (deck.cuePoint != null) tick(deck.cuePoint, "#ff8a3c", "C", 1.3, "cue");
    deck.hotCues.forEach((t, i) => {
      if (t != null) tick(t, CUE_COLORS[i % CUE_COLORS.length], String(i + 1), 1.3, "hot");
    });
    // ---- ONE RESOLVED PAINT ----------------------------------------------------------------
    // Ticks first (every mark keeps its line and stays snappable), then only the labels that fit.
    const labelled = resolveLabels(
      marks.map((m) => ({
        y: (m.t / dur) * h,
        lane: markerLane(m.kind),
        priority: markerPriority(m.kind),
        label: m.label,
      })),
      shareCol,
    );
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      drawTick((m.t / dur) * h, m.color, labelled[i] ? m.label : "", m.thickness, m.kind);
    }

    // The seam between the two lanes — faint, but it is what makes "sections on that side, my
    // cues on this side" readable rather than something you have to be told.
    if (marks.length) {
      ctx.fillStyle = rgba(p.selectorColor, 0.1);
      ctx.fillRect(w / 2 - 0.5 * dpr, 0, 1 * dpr, h);
    }
    markersRef.current = marks;
  };

  // Per-frame composite: blit the static layer, then draw the two things that actually move —
  // the viewport-window ghost and the live playhead.
  const draw = () => {
    const el = canvasRef.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    if (staleRef.current) {
      staleRef.current = false;
      rasterizeStatic();
    }
    const p = view.current;
    const { w, h, dpr } = sizeRef.current;
    const layer = layerRef.current;
    if (layer) ctx.drawImage(layer, 0, 0);
    else {
      ctx.fillStyle = p.background;
      ctx.fillRect(0, 0, w, h);
    }

    const dur = deck.duration;
    if (!(dur > 0)) return;

    // ---- viewport-window ghost: where the zoomed main waveform is currently looking ----
    const rate = Math.max(deck.rate, 0.01);
    const trackWindow = p.windowSec * rate;
    const pos = deck.visualPosition();
    // Clamped: near either end of the track the window legitimately runs past it, and an
    // un-clamped rect put its top or bottom stroke outside the canvas — the ghost lost an edge
    // exactly where you most want to see where you are.
    // Half a line width in from each edge, because strokeRect centres the stroke ON the path:
    // clamped to exactly 0 the top edge would still paint half of itself outside.
    const vy0 = Math.max(0.5 * dpr, ((pos - trackWindow / 2) / dur) * h);
    const vy1 = Math.min(h - 0.5 * dpr, ((pos + trackWindow / 2) / dur) * h);
    ctx.strokeStyle = rgba(p.selectorColor, 0.55);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(0.5 * dpr, vy0, w - 1 * dpr, Math.max(1, vy1 - vy0));
    ctx.fillStyle = rgba(p.selectorColor, 0.08);
    ctx.fillRect(0, vy0, w, Math.max(1, vy1 - vy0));

    // ---- hover: the marker a click WOULD snap to, swollen so the snap zone is visible ----
    // ★ IT ASKS THE SAME FUNCTION THE CLICK ASKS (hitMarker). A rail that highlights one marker
    // and then seeks to a different one is worse than no highlight at all, so there is exactly one
    // place that decides and both callers go through it.
    // Hidden while DRAGGING, because a drag deliberately does not snap — promising a jump the
    // gesture will not make is the same lie in the other direction.
    const hi = draggingRef.current ? null : hoverRef.current;
    const m = hi != null ? markersRef.current[hi] : undefined;
    if (m) {
      const y = (m.t / dur) * h;
      const { x: lx, w: lw } = laneRect(m.kind, side, w);
      // The hovered marker wears the SAME grammar as its resting state, just heavier — a thicker
      // line with the same gap. Switching to a different shape on hover would read as a different
      // object. Its centre is computed FIRST, because the zone band below has to sit on the same
      // line the letter does; a band centred on the raw y while the mark was nudged down for its
      // label would put the "you are in the zone" cue a few px off the thing it belongs to.
      const hoverH = Math.max(2.4, m.thickness * 2) * dpr;
      const hbox = (m.label ? LABEL_BOX_PX + 2 : Math.max(2.4, m.thickness * 2)) * dpr;
      const cy = insetMark(y, hbox, h) + hbox / 2;
      const top = cy - hoverH / 2;
      // A soft band the height of the SNAP ZONE itself — the answer to "am I in the right place
      // to hit this?" is a picture of the zone, not a brighter line.
      const zoneH = MARKER_SNAP_PX * 2 * dpr;
      ctx.fillStyle = rgba(m.color, 0.13);
      ctx.fillRect(lx, Math.max(0, Math.min(h - zoneH, cy - zoneH / 2)), lw, zoneH);
      ctx.fillStyle = m.color;
      if (m.label) {
        ctx.font = `bold ${10 * dpr}px ui-monospace, monospace`;
        ctx.textBaseline = "middle";
        const gap = m.label.length * 7 * dpr + 8 * dpr;
        const gx = lx + (lw - gap) / 2;
        ctx.fillRect(lx, top, Math.max(0, gx - lx), hoverH);
        ctx.fillRect(gx + gap, top, Math.max(0, lx + lw - gx - gap), hoverH);
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.lineWidth = 3.5 * dpr;
        ctx.strokeStyle = "rgba(4,6,10,0.92)";
        ctx.strokeText(m.label, lx + lw / 2, cy);
        ctx.fillStyle = opaque(m.color);
        ctx.fillText(m.label, lx + lw / 2, cy);
      } else {
        ctx.fillRect(lx, top, lw, hoverH);
      }
    }

    // ---- live playhead ----
    ctx.fillStyle = p.selectorColor;
    ctx.fillRect(0, insetMark((pos / dur) * h, 2 * dpr, h), w, 2 * dpr);
  };

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      // "|| jogging || adjusting": paused frame-search / waveform-drag / loop-edge nudge on
      // the DECK still moves the playhead-ghost live here — gating on visualPlaying alone left
      // the rail frozen while a paused scrub happened right next to it.
      if (deck.visualPlaying || deck.jogging || deck.adjusting || dirty.current) {
        dirty.current = false;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared by every seek entry point (pointer, keyboard) — the actual transport action.
  //
  // ★ `dragging` IS THE WHOLE DIFFERENCE, and it is about cost, not about where you land.
  //   • `refresh()` is the PARENT's re-render, and it was called once per pointermove. A pointer
  //     can report faster than the screen refreshes (and coalesces even faster), so a drag was
  //     asking React to re-render the board a few hundred times a second to move one playhead —
  //     which it cannot do, so it drops frames, which is the stutter. It cannot simply be removed:
  //     the rail has its own rAF, but on a PAUSED deck nothing else redraws the main lane. So it
  //     is coalesced to at most one per frame.
  //   • `onSeek` is a shared-session intent (App: emitSeekTo). One per pointermove is a network
  //     message flood at pointer rate. Throttled while dragging, with a final one on release so a
  //     co-DJ always ends up where you did.
  const applySeek = (t: number, dragging = false) => {
    deck.seek(t);
    dirty.current = true;
    if (dragging) {
      queueRefresh();
      const now = performance.now();
      if (now - lastEmit.current >= 100) {
        lastEmit.current = now;
        onSeek?.(t);
      }
      return;
    }
    refresh();
    onSeek?.(t);
  };

  // ★ SNAP IS FOR THE PRESS, NOT FOR THE DRAG. The magnetic marker snap is a CLICK affordance
  // ("special click zones that skip to them precisely") and it was running on every pointermove,
  // so a drag was quantised to whatever markers it passed — on this rail (398px, 3:35) a 7px
  // radius is 3.8 SECONDS of stickiness per marker. See overviewSeek.ts; the sweep in its test
  // measures the old path at 80+ stuck samples and 5+ px lurches, which is the coarseness.
  // The rail's live geometry, so the seek and the hover ask about the same box.
  const geomOf = () => {
    const el = canvasRef.current;
    if (!el || !(deck.duration > 0)) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height, duration: deck.duration, left: r.left, width: r.width, side, coarse: coarseRef.current };
  };
  const seekAt = (clientX: number, clientY: number, snap: boolean) => {
    if (locked) return;
    const g = geomOf();
    if (!g) return;
    applySeek(overviewSeekTime(clientX, clientY, g, markersRef.current, snap), !snap);
  };

  // ★ HOVER IS A REF + A DIRTY BIT, NEVER STATE. It changes on every mouse move; the rail's own
  // rAF already redraws whatever `dirty` marks, so this costs zero React renders. Marking dirty
  // only when the answer CHANGES also keeps an idle pointer from repainting the rail forever.
  const setHover = (clientX: number | null, clientY: number | null) => {
    let next: number | null = null;
    if (!locked && clientX != null && clientY != null) {
      const g = geomOf();
      // ★ THE HOVER ASKS WITH X TOO. Highlighting by Y alone would light up a cue in the other
      // column while your pointer is over the sections half — the highlight has to promise
      // exactly what the click in that spot will do, side included.
      if (g) next = hitMarker(clientX, clientY, g, markersRef.current);
    }
    if (next !== hoverRef.current) {
      hoverRef.current = next;
      dirty.current = true;
    }
  };

  // Keyboard access — this is a real transport control, not decoration, so it needs to work
  // without a pointer: Up/Down step to the previous/next marker (cue, hot cue, phrase, loop
  // edge — whatever's actually on the rail), Home/End jump to track start/end.
  const seekToAdjacentMarker = (dir: 1 | -1) => {
    if (locked || !(deck.duration > 0)) return;
    const pos = deck.position();
    const times = markersRef.current.map((m) => m.t).sort((a, b) => a - b);
    let target: number | undefined;
    if (dir > 0) target = times.find((t) => t > pos + 0.05);
    else {
      for (let i = times.length - 1; i >= 0; i--) {
        if (times[i] < pos - 0.05) {
          target = times[i];
          break;
        }
      }
    }
    applySeek(target ?? (dir > 0 ? deck.duration : 0));
  };

  return (
    <canvas
      ref={canvasRef}
      className={`song-overview song-overview-${side} ${dropActive ? "drop-target" : ""}`}
      style={{ ["--accent" as string]: props.accent }}
      role="slider"
      aria-label={`${side === "left" ? "Deck A" : "Deck B"} song overview — full-track playhead`}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.max(1, Math.round(deck.duration))}
      aria-valuenow={Math.round(deck.visualPosition())}
      tabIndex={locked ? -1 : 0}
      onPointerDown={(e) => {
        onFocus?.();
        // ★ CAPTURE IS AN OPTIMISATION, NOT A PRECONDITION. `setPointerCapture` THROWS when the
        // browser does not consider that pointer active (NotFoundError), and it was the second
        // statement in the handler — so a throw took the seek, the highlight and the whole press
        // with it. Found because synthetic touch events could not be captured and the rail simply
        // did nothing for them while mouse presses worked; the same shape would swallow a real
        // press on any device that ever refuses capture. Capture only improves the DRAG (it keeps
        // events coming when the finger leaves the rail); the press must land regardless.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* no capture — the drag may end early if the pointer leaves, but the press still works */
        }
        coarseRef.current = e.pointerType === "touch" || e.pointerType === "pen";
        lastEmit.current = 0; // the press itself always reaches the session
        moved.current = false;
        // ★ THE PRESS IS TOUCH'S HOVER. Label suppression was justified by "the hover highlight
        // draws whatever you point at, so nothing is lost" — and on a phone there IS no hover, so
        // a suppressed label was simply gone with no way to ask. A press now raises the highlight
        // for whatever it resolved to, which both restores the missing identity AND tells a fat
        // finger what it actually hit. `dragging` is armed on the first MOVE, not here, so the
        // highlight survives a tap and only disappears once you are genuinely scrubbing.
        seekAt(e.clientX, e.clientY, true); // the press MAY snap
        setHover(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return void setHover(e.clientX, e.clientY);
        moved.current = true;
        draggingRef.current = true;
        seekAt(e.clientX, e.clientY, false); // the drag never does
      }}
      onPointerLeave={(e) => {
        // A finger has nowhere to "leave" to — clearing on lift would blank the very feedback the
        // tap just produced. Only a real cursor leaving the rail drops the highlight.
        if (e.pointerType === "mouse") setHover(null, null);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setHover(null, null);
      }}
      onPointerUp={(e) => {
        if (locked) return;
        // ★ ONLY RE-SEEK IF THIS WAS A DRAG. A plain CLICK near a marker snaps on the press, and
        // re-running the mapping unsnapped on release would immediately undo it — the snap would
        // survive exactly as long as the mouse button did. (Mine, caught before it shipped: the
        // release handler is new, and it inherited "always seek" from the move it was modelled on.)
        if (moved.current) seekAt(e.clientX, e.clientY, false);
        draggingRef.current = false;
        setHover(e.clientX, e.clientY); // the pointer is still on the rail — show what a click would do now
        // One authoritative render + intent at the end, so the co-DJ and the board both land on
        // exactly where the finger stopped rather than on the last throttled sample.
        refresh();
        onSeek?.(deck.position());
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          seekToAdjacentMarker(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          seekToAdjacentMarker(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          if (!locked) applySeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          if (!locked && deck.duration > 0) applySeek(deck.duration);
        }
      }}
      // Drop target — same track-row / audio-file drag the main waveform lane accepts, so
      // loading a deck doesn't require aiming for the (smaller, on mobile) main waveform when
      // this full-height rail is right there too.
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const raw = e.dataTransfer.getData(TRACK_DND_MIME);
        if (raw && onLoadTrack) {
          try {
            const parsed = JSON.parse(raw);
            const first = (Array.isArray(parsed) ? parsed[0] : parsed) as TrackMeta | undefined;
            if (first && first.videoId) {
              onLoadTrack(first);
              return;
            }
          } catch {
            /* fall through to a file drop */
          }
        }
        const f = e.dataTransfer.files[0];
        if (f && onLoadFile) onLoadFile(f);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TRACK_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        } else {
          e.preventDefault();
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
      }}
    />
  );
}

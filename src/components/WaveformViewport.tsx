import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import type { Pyramid, PyramidLevel } from "@htl/analysis";
import { hexRGB, bandRamp, tiltLuma, debrick, sampleBands } from "@htl/analysis";
import { deckShades } from "../htl/state/randomPalette";
import { GRID_ALPHA, GRID_W, gridLod } from "./gridLod";

interface WaveformViewportProps {
  // The deck is read LIVE inside an imperative rAF (position, beatgrid, loop,
  // stems, mutes …) so playback/scrub never re-render React — the heavy waveform
  // is rasterised once into an offscreen layer and just GPU-blitted per frame.
  deck: Deck;
  pyramid: Pyramid | null; // mix LOD (stable per track)
  accent: string;
  background: string; // lane surface (--surface), passed as a value so a bg change paints live
  selectorColor: string;
  loopColor: string;
  markerColor: string;
  stripColor: string;
  stemColors: Record<string, string>; // per-stem overrides; "" / missing = built-in default
  freqColors: boolean; // collapsed (non-stem) wave: rekordbox-style low/mid/high band colours
  freqLow: string; // band hues (already resolved to a real hex — never "")
  freqMid: string;
  freqHigh: string;
  vividness: number; // band-colour saturation (0 grey … 1 as-picked … 2 neon)
  bandLayers: boolean; // band style: layered rekordbox-style lobes where the lane is tall enough (see LAYER_MIN_LANE), else the flat per-column tint
  bandFromDeck: boolean; // bands as SHADES of this deck's accent rather than three independent hues
  stemsFollowDeck: boolean; // the four stem LANES take shades of this deck's accent instead of their own colours
  debrick: boolean; // re-expand local contrast on brick-walled masters (see debrick())
  glow: boolean; // neon bloom halo behind the waveform
  markerThickness: number; // px width of the cue/loop/hot-cue + phrase marker bars
  gridSize: number;
  // A replacement stem set is being computed (model switch / enhance), as a 0–100 %, or
  // null when idle. Only dims/overlays when stems are ALREADY shown — the FIRST separation
  // has no stem lanes (the deck shows the plain mix), so it stays clean.
  separating: number | null;
  windowSec: number; // REAL seconds across the view (shared by both decks)
  onZoom: (nextWindowSec: number) => void;
  wheelSeeks?: boolean; // plain wheel: false = zoom the view (default), true = seek the playhead
  onScrubStart: () => void;
  onScrub: (deltaSeconds: number) => void;
  onScrubEnd: () => void;
  onNeedleDrop: (deltaSeconds: number) => void;
  onBend: (deltaSeconds: number) => void; // Shift+wheel → momentary pitch-bend (not a seek)
  // Release Brake and Censor have a keyboard/MIDI trigger each but, until now, no touch/mouse
  // equivalent at all (spinback at least has the flick-release gesture via decideRelease) —
  // a touch-only DJ with no keyboard or controller genuinely couldn't fire either one.
  onReleaseBrake: () => void; // long-press (no drag) — a deliberate hold, distinct from a tap-seek
  onCensorToggle: () => void; // two-finger tap (no pinch) — tap again (or the keyboard L key) to return
}

export const CUE_COLORS = ["#ff5d73", "#ffb13c", "#ffe24a", "#6ee7a8", "#36c2ff", "#7b9cff", "#c77bff", "#ff7bd0"];

// Per-stem waveform colours, stacked centre-out in this order (drums innermost).
const STEM_ORDER = ["drums", "bass", "vocals", "other"] as const;
// Layered bands encode each band's magnitude as its own lobe HEIGHT, so they need vertical
// room: three nested lobes in a lane shorter than this (CSS px) mush into one stripe, and the
// flat per-column tint — which encodes in HUE and costs no height — reads better there. The
// switch is on the MEASURED lane, never the device: a phone in single-deck view gives a stem
// lane ~54px and a 2560px desktop ~65px, while that same phone showing BOTH decks gives ~5px.
const LAYER_MIN_LANE = 28;

/** The track's loudest ENERGY, for debrick's reference — the same role trackPeak plays for the
 *  peak envelope. Scanned from a mid-resolution level (capped, so a long track costs the same as
 *  a short one) rather than the coarsest, which is averaged so far down that it reports the
 *  track's MEAN and would make every section look equally loud. Bands are weighted back toward
 *  true energy by bandPeaks before summing, since each was normalised to its own peak. */
export function trackEnergyPeak(py: Pyramid | null): number {
  if (!py || !py.levels.length) return 0;
  const bp = py.bandPeaks ?? [1, 1, 1];
  let lvl = py.levels[py.levels.length - 1];
  for (let i = py.levels.length - 1; i >= 0; i--) {
    lvl = py.levels[i];
    if (lvl.low.length >= 2048) break;
  }
  let peak = 0;
  for (let i = 0; i < lvl.low.length; i++) {
    const e = lvl.low[i] * bp[0] + lvl.mid[i] * bp[1] + lvl.high[i] * bp[2];
    if (e > peak) peak = e;
  }
  return peak;
}

/** The whole track's peak magnitude, in O(1): `max`/`min` reduce by Math.max/Math.min all the way
 *  up, so the coarsest pyramid level is a single bucket holding the track's extremes. Returns 0
 *  when there is no pyramid to ask, which callers read as "no track reference available". */
export function trackPeak(py: Pyramid | null): number {
  if (!py || !py.levels.length) return 0;
  const top = py.levels[py.levels.length - 1];
  let p = 0;
  for (let i = 0; i < top.max.length; i++) {
    if (top.max[i] > p) p = top.max[i];
    if (-top.min[i] > p) p = -top.min[i];
  }
  return p;
}

// ★ HOW MUCH OF THE TRUE BAND BALANCE TO SHOW. The pyramid normalises each band to its own peak
// (good for dynamics, see Pyramid.bandPeaks) and carries the discarded ratios alongside. This
// exponent picks a point on the line between the two readings:
//   0 = fully normalised — every band peaks at 1, so the loudest-per-column comparison is a
//       coin-toss the physics never had, and the high band paints over everything.
//   1 = literal energy — truthful, but music's highs sit tens of dB down, so they shrink to a
//       hairline and the picture becomes one colour for a different reason.
// A half-power tilt keeps the low band the body it really is while leaving the mid and high
// enough height to read as structure. It is a DISPLAY law, deliberately not a physical one.
export const BAND_TILT = 0.5;

const STEM_COLORS: Record<string, string> = {
  drums: "#ff5d73",
  bass: "#b06bff",
  vocals: "#5dff9e",
  other: "#36c2ff",
};
// Stable cache key for the per-stem colour overrides (recolour → re-rasterise).
const stemColsKey = (c: Record<string, string>) => STEM_ORDER.map((n) => c[n] || "").join(",");
// Cache key for the stem lanes: which stems exist + each one's BRIGHTNESS state
// (muted, or its knob level quantised to 0.25 steps). Quantising means dragging a
// stem knob only re-rasterises when it crosses a step, not every sub-pixel.
function stemMask(deck: Deck, st: Record<string, Pyramid> | null): string {
  if (!st) return "";
  return STEM_ORDER.filter((n) => st[n])
    .map((n) => (deck.stemActive(n) ? Math.round(Math.min(1.5, deck.stemLevel(n)) * 4) : "m"))
    .join(",");
}

// hex (#rgb / #rrggbb) → rgba() string at the given alpha; passes other inputs
// through unchanged so named/rgb colours still work.
function rgba(hex: string, a: number): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Below this many samples-per-pixel we abandon the 256-sample LOD and read the REAL PCM,
// so deep zoom resolves the true signal instead of staircased LOD plateaus. The LOD
// bucket is 256 samples, so at/above 256 spp the LOD never upsamples. The SAME signed
// envelope is drawn either way — LOD vs raw is purely a performance source swap.
const RAW_SPP = 256;

// Cap the canvas backing store at 2× device pixels. Phones report dpr 3–4; a dpr-3 panel
// rasterises ~2.25× the pixels of dpr-2 for no visible gain on a soft waveform or grid
// text, while every per-frame composite AND every offscreen rebuild pays that area. The
// single biggest mobile lever — applies to the whole component, not just the wave layer.
const MAX_DPR = 2;

// The coarsest LOD level whose bucket still fits within `spp` samples-per-pixel (so each
// pixel averages ≥1 bucket → no upsampling). Levels are ordered finest→coarsest.
function pickLevel(py: Pyramid, spp: number): PyramidLevel {
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
function envelope(
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

// Per-column low/mid/high band energy (0..1) sampled from a LOD level — the data behind
// the rekordbox/Serato frequency-coloured waveform. Max over the buckets a column spans
// (mirrors the min/max envelope). The caller passes the finest level even when zoomed into
// raw PCM, so colour holds at every zoom.

// Rekordbox-style band colour anchors: blue(bass) / amber(mid) / white(high). The per-
// column blend (weighted by each band's energy) is computed inline in paintBanded so the
// rgb() string is rebuilt only on a colour change, not per pixel.
// #rrggbb → [r,g,b]. The frequency-colour band hues come from settings (resolved to a real
// hex), parsed once per rasterise; the per-column blend is computed inline in paintBanded so
// the rgb() string is rebuilt only on a colour change, not per pixel.
// Perceptual amplitude curve: music peaks well below full scale, so a linear map leaves
// every waveform a thin sliver in a sea of black. A gentle gain + soft knee lifts quiet
// passages so they have body, while loud peaks ease into the lane edge instead of clipping
// flat. Sign-preserving so the signed waveform shape is kept.
//
// Baked into a LUT: shape() is the single hottest call in a rasterise — invoked up to 4×
// per column (top+bottom envelope, and again in paintBanded) across thousands of columns ×
// up to 4 stem lanes, so the soft-knee exp() ran tens of thousands of times per rebuild.
// The curve is a pure function of |v|, so a 2048-entry table over the gained magnitude
// turns it into a table lookup on the hot path. Visual envelope → no interpolation needed.
const SHAPE_LUT_N = 2048;
const SHAPE_LUT_MAX = 4; // domain of |v|·1.7; music exceeds unity, clamp past this (curve ≈1)
const SHAPE_LUT = (() => {
  const t = new Float32Array(SHAPE_LUT_N + 1);
  for (let i = 0; i <= SHAPE_LUT_N; i++) {
    const a = (i / SHAPE_LUT_N) * SHAPE_LUT_MAX;
    t[i] = a <= 0.8 ? a : 0.8 + (1 - 0.8) * (1 - Math.exp(-(a - 0.8) / (1 - 0.8)));
  }
  return t;
})();
export function shape(v: number): number {
  let a = v < 0 ? -v : v;
  a *= 1.7;
  const y = a >= SHAPE_LUT_MAX ? 1 : SHAPE_LUT[((a / SHAPE_LUT_MAX) * SHAPE_LUT_N) | 0];
  return v < 0 ? -y : y;
}


// What the offscreen waveform layer currently holds — rebuilt only when one of
// these changes (zoom/track/stems/mute/size/colour) or the view scrolls off it.
interface WaveMeta {
  left: number;
  span: number;
  win: number; // the VIEW window (zoom) this layer was built for — RATE-INDEPENDENT, so a
  // tempo change re-uses the layer (blit-scaled) instead of forcing a rebuild. Only a real
  // zoom (this changing) is a content-resolution change worth a fresh rasterise.
  secPerPx: number; // the VIEW's secPerPx at build time (for the coarse/fine ratio guard)
  colSec: number; // seconds per OFFSCREEN column (≥ secPerPx; the layer is rendered coarser)
  w: number;
  h: number;
  pyr: Pyramid | null;
  stems: Record<string, Pyramid> | null;
  mask: string;
  strip: string;
  accent: string;
  freq: boolean; // frequency-colour mode (toggle → re-rasterise)
  freqCols: string; // band hues joined — recolour → re-rasterise
  viv: number; // vividness (change → re-rasterise)
  layers: boolean; // layered-band mode AS RESOLVED for this size (the threshold can flip it on a resize)
  fromDeck: boolean; // bands derived from the deck accent (change → re-rasterise)
  stemsDeck: boolean; // stem lanes derived from the deck accent (change → re-rasterise)
  dbrk: boolean; // de-brickwall on/off (change → re-rasterise)
  glow: boolean; // glow on/off (change → re-rasterise)
  stemCols: string; // per-stem colour overrides, joined — recolour → re-rasterise
}

export function WaveformViewport(props: WaveformViewportProps) {
  const { deck, onZoom, onScrubStart, onScrub, onScrubEnd, onNeedleDrop, onBend } = props;
  const LONG_PRESS_MS = 450;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // `started` flips true only once the finger has moved past MOVE_PX — until then
  // it's a potential tap (instant seek), not a scrub.
  const drag = useRef<{ x: number; started: boolean } | null>(null);
  const tap = useRef<{ startX: number; relX: number; w: number } | null>(null);
  const pinch = useRef<Map<number, number>>(new Map());
  const pinchDist = useRef(0);
  // Long-press (single finger, no drag) → Release Brake. Cleared on release/cancel/drag-start
  // so a stale timer never fires after the gesture's already resolved into something else.
  const longPress = useRef<number | undefined>(undefined);
  const clearLongPress = () => { if (longPress.current) clearTimeout(longPress.current); longPress.current = undefined; };
  // Two-finger tap (both down, neither pinched) → Censor toggle. Non-null from the moment a
  // 2nd finger lands until both lift; `moved` flips true the instant the pinch distance shifts
  // beyond MOVE_PX, which is how a real pinch-zoom is told apart from a tap.
  const twoFinger = useRef<{ moved: boolean } | null>(null);
  const bgRef = useRef("#08080d"); // cached lane bg (--surface)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 }); // cached device-px size (no per-frame reflow)
  const dirty = useRef(true); // request one composite (set on any React render / resize)
  const waveRef = useRef<HTMLCanvasElement | null>(null); // offscreen rasterised waveform
  const scratchRef = useRef<HTMLCanvasElement | null>(null); // scratch for the scroll-shift blit
  const waveMeta = useRef<WaveMeta | null>(null);
  const prevPos = useRef<number>(Number.NaN); // last frame's playhead, to detect a seek/cue JUMP
  const geomKey = useRef(""); // last frame's zoom/size signature — so a zoom DEBOUNCE settles
  const rebuildTimer = useRef(0); // debounced crisp rebuild after a zoom settles
  const localWin = useRef<number | null>(null); // live zoom during a gesture (avoids App re-renders)
  const zoomCommit = useRef(0);
  const view = useRef(props); // latest React-controlled inputs, read by the rAF
  view.current = props;
  // Drive the lane background off the prop (not getComputedStyle): applySettings
  // writes --surface in a parent effect that runs AFTER this component's effects,
  // so reading the CSS var would be one commit stale. The prop is always fresh,
  // and line below already flags dirty so a paused deck repaints immediately.
  bgRef.current = props.background || bgRef.current;
  // Once App state has caught up to the gesture's committed zoom, drop the local
  // override so props drive again.
  if (localWin.current != null && Math.abs(localWin.current - props.windowSec) < 1e-6) localWin.current = null;
  dirty.current = true; // any render (zoom, theme, loop set, mute…) → redraw once

  // Apply a zoom LOCALLY for instant feedback (the rAF redraws via dirty) and
  // commit it to App state only after the gesture settles — so a wheel/pinch burst
  // doesn't re-render the whole app per tick.
  const applyZoom = (next: number) => {
    localWin.current = next;
    dirty.current = true;
    if (zoomCommit.current) clearTimeout(zoomCommit.current);
    zoomCommit.current = window.setTimeout(() => {
      zoomCommit.current = 0;
      if (localWin.current != null) onZoom(localWin.current);
    }, 90);
  };

  const MOVE_PX = 4;

  // Measure the canvas box ONCE per resize (not per frame) and size its backing
  // store to device pixels. getBoundingClientRect here would otherwise force a
  // synchronous layout flush every animation frame — the main jank source.
  const measure = () => {
    const el = canvasRef.current;
    if (!el) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    const changed = el.width !== w || el.height !== h;
    if (changed) {
      el.width = w;
      el.height = h;
    }
    sizeRef.current = { w, h, dpr };
    dirty.current = true;
    // DON'T discard the offscreen layer here. draw() blit-SCALES the existing layer to the
    // new box (a cheap GPU stretch) and debounces ONE crisp rebuild once the size settles —
    // so expand/collapse a deck (DECK A/B focus) or open a dock feels instant instead of
    // blocking on a full re-rasterise at the new (often larger) size before the first paint.
    // Assigning el.width above BLANKS the canvas; ResizeObserver fires before paint, so
    // redraw synchronously NOW (the blit fills it) — otherwise the cleared canvas shows for
    // one frame and the waveform visibly blinks out and back.
    if (changed) draw();
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
  useEffect(() => clearLongPress, []); // don't fire a stale hold-to-brake after unmount (deck switch mid-press)
  // Re-read the themed background + invalidate the layer on theme / zoom changes.
  useEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.accent, props.stripColor, props.loopColor, props.markerColor, props.selectorColor, props.freqColors, props.freqLow, props.freqMid, props.freqHigh, props.vividness, props.bandLayers, props.bandFromDeck, props.stemsFollowDeck, props.debrick, props.glow, stemColsKey(props.stemColors)]);

  const clampWin = (wsec: number) => {
    const dur = deck.duration || 1; // scalar — survives the mobile mix-buffer release
    return Math.max(0.003, Math.min(Math.max(1, dur) * 1.1, wsec));
  };

  // Rasterise the waveform (stem-stacked, mix LOD, or raw samples) into `ctx`
  // across [rLeft, rLeft + ow*secPerPx]. Runs only on a layer rebuild, NOT per
  // frame — so the expensive per-pixel loop + colour-string allocation amortises.
  const rasterize = (
    ctx: CanvasRenderingContext2D,
    rLeft: number,
    secPerPx: number,
    ow: number,
    h: number,
  ) => {
    const p = view.current;
    const mid = h / 2;
    // `h` is DEVICE pixels; the layer threshold is in CSS px, so undo the DPR scale.
    const dprNow = sizeRef.current.dpr || 1;
    const stems = deck.stemPyramids;
    const lo = new Float32Array(ow);
    const hi = new Float32Array(ow);
    const lb = new Float32Array(ow); // per-column low/mid/high band energy (freq-colour)
    const mb = new Float32Array(ow);
    const hb = new Float32Array(ow);
    const pk = new Float32Array(ow); // per-column loudest band (layered mode)
    const eb = new Float32Array(ow); // per-column ENERGY (RMS bands, weighted back to true balance) — debrick's contrast source
    // The MIX's band anchors (Settings ▸ Lows/Mids/Highs), parsed once per rasterise. A collapsed
    // waveform has no stem identity to carry, so the global palette is exactly right for it; a
    // stem lane builds its own ramp from its own colour instead (see bandRamp).
    // TWO readings of the same three hues, because the two renderers need opposite things.
    // The LAYERED one composites additively, so overlap makes its own brightness and the picked
    // hues go in untouched — that is what keeps a core telling you WHICH bands built it instead
    // of going white. The FLAT one paints one colour per column with nothing to composite, so
    // the dark→base→bright ordering has to be baked into the colours or the nesting reads
    // inside-out (the shipped defaults put the mid brightest — see tiltLuma).
    // ★ OR: THE BANDS ARE THE DECK'S OWN COLOUR. Three independently-picked hues have no relation
    // to each other or to the deck they belong to, which is how the shipped defaults ended up
    // mis-ordered in the first place. Deriving them from the accent — the same bandRamp the stem
    // lanes use — makes the relationship structural instead of a thing to get right by hand: one
    // hue, three shades, and the additive overlap supplies the bright core. It also makes each
    // deck's waveform read as THAT deck at a glance, which two shared palettes never could.
    const mixRaw: [[number, number, number], [number, number, number], [number, number, number]] =
      p.bandFromDeck
        // ★ `accent`, NOT `stripColor` — the SAME trap as the stem lanes, left behind when that one
        // was fixed. Strip is a single GLOBAL colour, so falling back through it means every deck's
        // wave comes out the same, which is precisely what "follow the DECK colour" promises not to
        // do. It also outranked the album-art accent: a deck themed orange by its cover still drew
        // a green wave, because Strip was set and got asked first.
        ? bandRamp(p.accent)
        : [hexRGB(p.freqLow), hexRGB(p.freqMid), hexRGB(p.freqHigh)];
    const mixFlat = p.bandFromDeck ? mixRaw : tiltLuma(mixRaw);
    // One ramp per stem, built once per rasterise rather than per lane per column.
    // ★ OR THE WHOLE DECK IN ONE HUE. With `stemsFollowDeck` the four lanes are shades of this
    // deck's own accent instead of four independent colours, so a glance at any lane tells you
    // which deck you are on. Hue is then spoken for, so the lanes are told apart by BRIGHTNESS —
    // the same trade the mono palette makes — and each lane still gets its own band ramp on top.
    // PER DECK, and deliberately from `accent` rather than `stripColor`: Strip is one global
    // colour, so basing the lanes on it would give both decks the same stems and lose the whole
    // point. `accent` is this deck's own — and when Deck artwork is on it is derived from the
    // loaded track's cover, so the lanes re-colour to whatever is playing, per deck, for free.
    // The layer already rebuilds on an accent change (see contentStale), so that follows live.
    const laneBase = p.stemsFollowDeck ? deckShades(p.accent, STEM_ORDER.length) : null;
    const stemCols: Record<string, [[number, number, number], [number, number, number], [number, number, number]]> = {};
    STEM_ORDER.forEach((n, i) => {
      stemCols[n] = bandRamp(laneBase ? laneBase[i] : p.stemColors[n] || STEM_COLORS[n] || p.accent);
    });
    const viv = p.vividness; // band saturation
    const glow = p.glow; // deck-coloured bloom behind the wave

    // ONE signed-envelope renderer, used identically for the mix and every stem lane. The
    // shape is the same at all zooms — it just compresses sideways as you zoom out and
    // resolves down to individual samples as you zoom in. `srcSr`/`raw`/`lodPy` pick the
    // cheapest source for the zoom (LOD when out, raw PCM when in); the visual is identical.
    const buildSilhouette = (yc: number, amp: number): Path2D => {
      const path = new Path2D();
      path.moveTo(0, yc - shape(hi[0]) * amp);
      for (let x = 1; x < ow; x++) path.lineTo(x, yc - shape(hi[x]) * amp); // top edge (max) →
      for (let x = ow - 1; x >= 0; x--) path.lineTo(x, yc - shape(lo[x]) * amp); // bottom edge (min) ←
      path.closePath();
      return path;
    };
    const fillEnvelope = (srcSr: number, raw: Float32Array | null, raw1: Float32Array | null, lodPy: Pyramid | null) => {
      if (raw) envelope(raw, raw1, srcSr, rLeft, secPerPx, ow, lo, hi, null);
      else if (lodPy) envelope(null, null, srcSr, rLeft, secPerPx, ow, lo, hi, pickLevel(lodPy, secPerPx * srcSr));
      else return false;
      // De-brickwall only when each column aggregates many samples (envelope view). Zoomed in
      // far enough to resolve individual wave cycles, lo/hi IS the real signed waveform and
      // there's no brick to open up — remapping it would distort the trace.
      if (p.debrick && secPerPx * srcSr >= 48) {
        // The bands ARE an RMS loudness curve (analyze.ts stores sqrt(sum/count) per bucket), so
        // sampling them here costs one pass and gives debrick a contour that limiting could not
        // flatten. lb/mb/hb are safe scratch: whichever painter runs next refills them.
        let en: Float32Array | null = null;
        let enPeak = 0;
        if (lodPy) {
          sampleBands(pickLevel(lodPy, secPerPx * srcSr), srcSr, rLeft, secPerPx, ow, lb, mb, hb);
          const bp = lodPy.bandPeaks ?? [1, 1, 1];
          for (let x = 0; x < ow; x++) eb[x] = lb[x] * bp[0] + mb[x] * bp[1] + hb[x] * bp[2];
          en = eb;
          enPeak = trackEnergyPeak(lodPy);
        }
        debrick(lo, hi, ow, secPerPx, trackPeak(lodPy), en, enPeak);
      }
      return true;
    };
    const paintWave = (
      srcSr: number,
      raw: Float32Array | null,
      raw1: Float32Array | null,
      lodPy: Pyramid | null,
      yc: number,
      amp: number,
      color: string,
    ) => {
      if (!fillEnvelope(srcSr, raw, raw1, lodPy)) return;
      const path = buildSilhouette(yc, amp);
      if (glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      }
      ctx.fillStyle = color;
      ctx.fill(path);
      ctx.shadowBlur = 0;
    };
    // Frequency-coloured variant: same silhouette, but each column is painted its band
    // colour (blue bass / amber mid / white high). COLOUR always comes from the LOD bands
    // (so it holds even when the SHAPE reads raw PCM); `alpha` dims a muted stem lane. The
    // per-column fills only run at rasterise time, so they stay off the per-frame path.
    const paintBanded = (
      srcSr: number,
      raw: Float32Array | null,
      raw1: Float32Array | null,
      lodPy: Pyramid,
      yc: number,
      amp: number,
      alpha: number,
      cols: [[number, number, number], [number, number, number], [number, number, number]],
    ) => {
      const [cL, cM, cH] = cols;
      if (!fillEnvelope(srcSr, raw, raw1, lodPy)) return;
      sampleBands(pickLevel(lodPy, secPerPx * srcSr), srcSr, rLeft, secPerPx, ow, lb, mb, hb);
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      // Glow = ONE deck-coloured, shadow-blurred fill of the silhouette behind the bands
      // (one fill, not per-column → cheap). Gives each deck a distinct bloom under the
      // shared band scheme.
      if (glow) {
        ctx.save();
        ctx.shadowColor = p.accent;
        ctx.shadowBlur = 9;
        ctx.fillStyle = rgba(p.accent, 0.5);
        ctx.fill(buildSilhouette(yc, amp));
        ctx.restore();
      }
      // The same balance correction the layered mode applies (see BAND_TILT) — the `/ sum` below
      // is just as blind to it, and without this a short lane falling back to the tint would
      // JUMP colour balance against the layered lane beside it.
      const bpT = lodPy.bandPeaks;
      if (bpT) {
        const wl = Math.pow(bpT[0], BAND_TILT), wm = Math.pow(bpT[1], BAND_TILT), wh = Math.pow(bpT[2], BAND_TILT);
        for (let x = 0; x < ow; x++) {
          lb[x] *= wl;
          mb[x] *= wm;
          hb[x] *= wh;
        }
      }
      // Each column is a 1px vertical bar spanning its own envelope top→bottom (the bars
      // ARE the silhouette, so NO clip), coloured by its band mix + vividness. The
      // fillStyle string is rebuilt ONLY when the quantised colour changes — flat regions
      // cost one fillStyle per run, not per pixel.
      let lastKey = -1;
      for (let x = 0; x < ow; x++) {
        const top = yc - shape(hi[x]) * amp;
        let height = yc - shape(lo[x]) * amp - top;
        if (height < 0.75) height = 0.75; // a visible sliver through silence
        const sum = lb[x] + mb[x] + hb[x] + 1e-4;
        let rf = (lb[x] * cL[0] + mb[x] * cM[0] + hb[x] * cH[0]) / sum;
        let gf = (lb[x] * cL[1] + mb[x] * cM[1] + hb[x] * cH[1]) / sum;
        let bf = (lb[x] * cL[2] + mb[x] * cM[2] + hb[x] * cH[2]) / sum;
        if (viv !== 1) {
          // Saturate around luminance: <1 toward grey, >1 boosts toward neon.
          const gray = 0.299 * rf + 0.587 * gf + 0.114 * bf;
          rf = gray + (rf - gray) * viv;
          gf = gray + (gf - gray) * viv;
          bf = gray + (bf - gray) * viv;
        }
        const r = (rf < 0 ? 0 : rf > 255 ? 255 : rf | 0) & 0xf8;
        const g = (gf < 0 ? 0 : gf > 255 ? 255 : gf | 0) & 0xf8;
        const b = (bf < 0 ? 0 : bf > 255 ? 255 : bf | 0) & 0xf8;
        const key = (r << 16) | (g << 8) | b;
        if (key !== lastKey) {
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          lastKey = key;
        }
        ctx.fillRect(x, top, 1, height);
      }
      ctx.restore();
    };
    // ★ REKORDBOX-STYLE LAYERED BANDS: THE BANDS STACK, THEY DO NOT NEST.
    // Two earlier shapes of this were wrong in instructive ways. Painting three CONCENTRIC lobes
    // opaquely made each one delete what it covered, so the band carrying most of the music
    // survived only as a rim. Compositing those same concentric lobes additively fixed the
    // deletion and introduced a worse artefact: every lobe is centred on the SAME line, so the
    // innermost region always contains all three bands and always sums to white — a permanent
    // white stripe whose thickness is just the smallest lobe, reporting nothing.
    // The fix is to stop overlapping at all. Each band owns its own SLICE of the column, ordered
    // outward from the centre — high, then mid, then low — and its thickness IS its share of the
    // energy there. Nothing is hidden behind anything, nothing sums to white, and the picture
    // becomes readable rather than decorative: a bass-heavy bar is visibly mostly low-coloured,
    // a hi-hat is a bright sliver. The outer silhouette is untouched, so the wave keeps exactly
    // the shape every other mode draws.
    const paintLayered = (
      srcSr: number,
      raw: Float32Array | null,
      raw1: Float32Array | null,
      lodPy: Pyramid,
      yc: number,
      amp: number,
      alpha: number,
      cols: [[number, number, number], [number, number, number], [number, number, number]],
    ) => {
      if (!fillEnvelope(srcSr, raw, raw1, lodPy)) return;
      sampleBands(pickLevel(lodPy, secPerPx * srcSr), srcSr, rLeft, secPerPx, ow, lb, mb, hb);
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      if (glow) {
        ctx.save();
        ctx.shadowColor = p.accent;
        ctx.shadowBlur = 9;
        ctx.fillStyle = rgba(p.accent, 0.5);
        ctx.fill(buildSilhouette(yc, amp));
        ctx.restore();
      }
      // Restore as much of the real spectral balance as BAND_TILT asks for. Without it the shares
      // below are computed from three bands that were each scaled to peak at 1, which answers
      // "how near its own maximum is this band" rather than "how much of this sound is it".
      const bp = lodPy.bandPeaks;
      const wL = bp ? Math.pow(bp[0], BAND_TILT) : 1;
      const wM = bp ? Math.pow(bp[1], BAND_TILT) : 1;
      const wH = bp ? Math.pow(bp[2], BAND_TILT) : 1;
      // Cumulative boundaries, as fractions of the column's half-height, measured from the centre
      // out: pk holds high's share, and (pk + mid's share) — low simply takes the rest, so the
      // three always tile the envelope exactly with no seam and no overlap.
      for (let x = 0; x < ow; x++) {
        const l = lb[x] * wL;
        const m = mb[x] * wM;
        const h2 = hb[x] * wH;
        const sum = l + m + h2;
        if (sum <= 1e-6) {
          pk[x] = 0;
          lb[x] = 0;
          continue;
        }
        pk[x] = h2 / sum; // boundary 1: high occupies [0, pk]
        lb[x] = (h2 + m) / sum; // boundary 2: mid occupies [pk, lb]; low takes [lb, 1]
      }
      const cl = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
      // High first (innermost), low last (outermost) — drawn in any order, since they tile.
      const slices: Array<[number, [number, number, number]]> = [
        [0, cols[2]],
        [1, cols[1]],
        [2, cols[0]],
      ];
      for (const [si, col] of slices) {
        let [rf, gf, bf] = col;
        if (viv !== 1) {
          const gray = 0.299 * rf + 0.587 * gf + 0.114 * bf;
          rf = gray + (rf - gray) * viv;
          gf = gray + (gf - gray) * viv;
          bf = gray + (bf - gray) * viv;
        }
        const path = new Path2D();
        // Inner and outer boundary of this slice, as a fraction of the half-height.
        const innerAt = (x: number) => (si === 0 ? 0 : si === 1 ? pk[x] : lb[x]);
        const outerAt = (x: number) => (si === 0 ? pk[x] : si === 1 ? lb[x] : 1);
        // Upper ribbon: out along the outer edge, back along the inner one.
        for (let x = 0; x < ow; x++) path.lineTo(x, yc - shape(hi[x]) * amp * outerAt(x));
        for (let x = ow - 1; x >= 0; x--) path.lineTo(x, yc - shape(hi[x]) * amp * innerAt(x));
        path.closePath();
        // Lower ribbon, mirrored — a separate subpath in the same fill, so it is still one fill.
        path.moveTo(0, yc - shape(lo[0]) * amp * outerAt(0));
        for (let x = 0; x < ow; x++) path.lineTo(x, yc - shape(lo[x]) * amp * outerAt(x));
        for (let x = ow - 1; x >= 0; x--) path.lineTo(x, yc - shape(lo[x]) * amp * innerAt(x));
        path.closePath();
        ctx.fillStyle = `rgb(${cl(rf)},${cl(gf)},${cl(bf)})`;
        ctx.fill(path);
      }
      // A hairline through silence, so a gap still reads as a line rather than as nothing.
      ctx.fillStyle = `rgb(${cl(cols[0][0])},${cl(cols[0][1])},${cl(cols[0][2])})`;
      for (let x = 0; x < ow; x++) {
        if (shape(hi[x]) * amp - shape(lo[x]) * amp < 0.75) ctx.fillRect(x, yc - 0.375, 1, 0.75);
      }
      ctx.restore();
    };
    // Does this pyramid carry real band data? Remote-stem display (setRemoteStemView) has it
    // zeroed — fall back to the flat stem colour rather than painting a lane black.
    const hasBands = (py: Pyramid): boolean => {
      // Scan the whole coarse top level, not just bucket[0] — a stem silent at the track START
      // (vocals after an intro) has zero energy in the first bucket but real bands later.
      // Early-exits on the first non-zero bucket, so a real-band pyramid costs O(1).
      const { low, mid, high } = py.levels[py.levels.length - 1];
      for (let i = 0; i < low.length; i++) {
        if (low[i] + mid[i] + high[i] > 1e-6) return true;
      }
      return false;
    };

    if (stems) {
      // Stems present (DSP or neural) → one lane PER stem: the SAME waveform style as the
      // collapsed view, just drawn 4× into stacked sub-regions (so there's only ever one
      // renderer). A muted stem keeps its lane, drawn faint, so muting live never reflows
      // the layout. (DSP gets the quad view too now, to judge whether it's worth it.)
      const laneH = h / STEM_ORDER.length;
      const half = (laneH / 2) * 0.88; // small gap between lanes
      for (let li = 0; li < STEM_ORDER.length; li++) {
        const name = STEM_ORDER[li];
        const py = stems[name];
        if (!py) continue;
        const ssr = py.sampleRate;
        const raw = secPerPx * ssr < RAW_SPP ? deck.stemChannel(name) : null;
        // Brightness tracks the stem's KNOB level (muted/0 → dim, unity → full).
        const amp = deck.stemActive(name) ? deck.stemLevel(name) : 0;
        const alpha = 0.16 + 0.84 * Math.min(1, amp);
        const yc = (li + 0.5) * laneH;
        if (p.freqColors && hasBands(py)) {
          // Each stem in ITS OWN hue family (bandRamp), layered where the lane can show the
          // nesting: hue answers "which stem", the nesting answers "what is in it".
          if (p.bandLayers && laneH / dprNow >= LAYER_MIN_LANE) paintLayered(ssr, raw, null, py, yc, half, alpha, stemCols[name]);
          else paintBanded(ssr, raw, null, py, yc, half, alpha, stemCols[name]);
        } else {
          const color = (laneBase ? laneBase[li] : null) || p.stemColors[name] || STEM_COLORS[name] || p.accent;
          paintWave(ssr, raw, null, py, yc, half, rgba(color, alpha));
        }
      }
    } else if (p.pyramid) {
      // ONE collapsed waveform — no stems, or while a split's per-stem envelopes are
      // still building. Full height. Reads raw PCM when zoomed in, but falls back to the
      // pyramid's sample rate + LOD-only render when the mix buffer has been released
      // (mobile, stems active) — so the trace still draws from the LOD.
      const bsr = deck.buffer?.sampleRate ?? p.pyramid.sampleRate;
      const raw = deck.buffer && secPerPx * bsr < RAW_SPP ? deck.buffer.getChannelData(0) : null;
      const raw1 = raw && deck.buffer!.numberOfChannels > 1 ? deck.buffer!.getChannelData(1) : null;
      if (p.freqColors) {
        // rekordbox-style 3-band colour of the mix — full height, so it layers unless the
        // whole lane is a sliver (both decks on a phone: the wave canvas measures ~21px).
        if (p.bandLayers && h / dprNow >= LAYER_MIN_LANE) paintLayered(bsr, raw, raw1, p.pyramid, mid, mid * 0.95, 1, mixRaw);
        else paintBanded(bsr, raw, raw1, p.pyramid, mid, mid * 0.95, 1, mixFlat);
      } else {
        // Flat single colour (Strip colour, else the deck accent — so clearing Strip
        // gives each deck its own colour).
        paintWave(bsr, raw, raw1, p.pyramid, mid, mid * 0.95, p.stripColor || p.accent);
      }
    }
  };

  // Rasterise a fresh offscreen layer (3× viewport wide) centred on the view.
  // This is the only place the heavy per-pixel loop runs.
  const rebuildWave = (left: number, tw: number, secPerPx: number, win: number, w: number, h: number) => {
    const p = view.current;
    const stems = deck.stemPyramids;
    const mask = stemMask(deck, stems);
    const span = tw * 3;
    const waveLeft = left - tw;
    // The offscreen wave is GPU-blitted (scaled) into the lane, so it doesn't need full
    // device-pixel column density — render it at ~1.5 columns per CSS pixel regardless of
    // DPR. On a dpr-2/3 phone this is the dominant rebuild saving (fewer columns → fewer
    // per-column band fillRects, the hot loop). Grid + text stay crisp (main canvas, full
    // res). `colSec` (seconds per offscreen column) drives the blit so the math is exact
    // whatever the column count; at dpr 1 waveQ is 1 → desktop is unchanged.
    const waveQ = Math.min(1, 1.5 / sizeRef.current.dpr);
    const ow = Math.max(2, Math.round(w * 3 * waveQ));
    const colSec = span / ow;
    let wc = waveRef.current;
    if (!wc) {
      wc = document.createElement("canvas");
      waveRef.current = wc;
    }
    if (wc.width !== ow || wc.height !== h) {
      wc.width = ow;
      wc.height = h;
    }
    const wctx = wc.getContext("2d");
    if (!wctx) return;
    wctx.clearRect(0, 0, ow, h);
    rasterize(wctx, waveLeft, colSec, ow, h);
    waveMeta.current = { left: waveLeft, span, win, secPerPx, colSec, w, h, pyr: p.pyramid, stems, mask, strip: p.stripColor, accent: p.accent, freq: p.freqColors, freqCols: p.freqLow + p.freqMid + p.freqHigh, viv: p.vividness, layers: p.bandLayers, fromDeck: p.bandFromDeck, stemsDeck: p.stemsFollowDeck, dbrk: p.debrick, glow: p.glow, stemCols: stemColsKey(p.stemColors) };
    if (rebuildTimer.current) {
      clearTimeout(rebuildTimer.current);
      rebuildTimer.current = 0;
    }
  };

  // Keep the cached layer centred on the moving view by SHIFTING it and rasterising only the
  // newly-exposed leading strip — instead of re-rasterising the whole 3×-wide layer every time
  // playback scrolls off it. This is the core playback-smoothness fix: a full rebuild is O(span)
  // and used to fire in a single rAF frame every ~0.9 window-widths of scroll (a periodic spike
  // that, at deep zoom, lands every few frames and the playhead can outrun) — the sawtooth GPU
  // burst + the visible skips. Shifting turns it into O(Δcolumns) of steady per-frame work: a
  // cheap GPU blit of the existing pixels + a tiny strip raster at the edge.
  //
  // `m` MUST match the current geometry (same win, w, h) — the caller guarantees it. Returns
  // false if the shift is too large to be a scroll (a seek/jump) so the caller full-rebuilds.
  const PAD = 12; // strip overlap (≥ glow blur radius) so the re-rendered seam is glow-continuous
  const shiftToCover = (left: number, trackWindow: number, m: WaveMeta): boolean => {
    const wc = waveRef.current;
    if (!wc) return false;
    const ow = wc.width;
    const h = wc.height;
    // Target: re-centre the view inside the layer so there's symmetric runway both directions.
    const wantLeft = left - (m.span - trackWindow) / 2;
    const shiftCols = Math.round((wantLeft - m.left) / m.colSec);
    if (shiftCols === 0) return true; // sub-column drift — the blit's fractional srcX covers it
    if (Math.abs(shiftCols) >= ow - PAD) return false; // a jump, not a scroll → let caller rebuild
    const wctx = wc.getContext("2d");
    if (!wctx) return false;

    // Shift existing pixels via a scratch copy (robust vs. overlapping self-blit). Forward play
    // (shiftCols > 0) moves content LEFT; a backward seek moves it right.
    let sc = scratchRef.current;
    if (!sc) {
      sc = document.createElement("canvas");
      scratchRef.current = sc;
    }
    if (sc.width !== ow || sc.height !== h) {
      sc.width = ow;
      sc.height = h;
    }
    const sctx = sc.getContext("2d");
    if (!sctx) return false;
    sctx.clearRect(0, 0, ow, h);
    sctx.drawImage(wc, 0, 0);
    wctx.clearRect(0, 0, ow, h);
    wctx.drawImage(sc, -shiftCols, 0);

    // Re-rasterise the now-uncovered band (+ PAD on the preserved side so glow joins seamlessly).
    const newStart = shiftCols > 0 ? ow - shiftCols : 0;
    const c0 = Math.max(0, newStart - PAD);
    const c1 = Math.min(ow, newStart + Math.abs(shiftCols) + PAD);
    const newLeft = m.left + shiftCols * m.colSec;
    wctx.clearRect(c0, 0, c1 - c0, h);
    wctx.save();
    wctx.translate(c0, 0);
    rasterize(wctx, newLeft + c0 * m.colSec, m.colSec, c1 - c0, h);
    wctx.restore();
    m.left = newLeft;
    return true;
  };

  // Per-frame composite: background, loop tint, the blitted waveform, grid,
  // markers, playhead. Cheap — the only heavy bit (waveform) is a cached blit.
  const draw = () => {
    const el = canvasRef.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    if (w === 0) return;
    const p = view.current;

    ctx.fillStyle = bgRef.current;
    ctx.fillRect(0, 0, w, h);
    // Render from the LOD pyramid (mix) or the stem pyramids — NOT the raw float32 buffer.
    // On mobile the buffer is RELEASED once stems pack into the worklet (releaseMixBuffer,
    // the OOM fix), so gating draw on `deck.buffer` blanked the whole deck — waveform AND
    // playhead — the instant stems loaded. The pyramids carry the visuals; the raw-PCM
    // deep-zoom overlay is separately, null-safely guarded below.
    if (!p.pyramid && !deck.stemPyramids) return;

    const pos = deck.visualPosition();
    const r = Math.max(deck.rate, 0.01);
    const trackWindow = (localWin.current ?? p.windowSec) * r;
    const left = pos - trackWindow / 2;
    // A seek/cue/loop JUMP moves the playhead far more than playback could in one frame
    // (smooth play is ≤ rate·dt ≈ rate/60 s). The incremental scroll-shift below is built
    // for smooth scrolling, NOT a discontinuity — trusting it across a jump left the stem
    // lanes blank. Detect the jump and force a clean full rebuild instead.
    const jumped = Number.isFinite(prevPos.current) && Math.abs(pos - prevPos.current) > r * 0.1 + 0.02;
    prevPos.current = pos;
    const secPerPx = trackWindow / w;
    const toX = (t: number) => ((t - left) / trackWindow) * w;

    // Loop region — tinted fill + bright edge bars.
    const loop = deck.loop;
    if (loop && loop.end > loop.start) {
      const lx = toX(loop.start);
      const lw = (loop.end - loop.start) / secPerPx;
      ctx.fillStyle = rgba(p.loopColor, loop.active ? 0.2 : 0.1); // dimmer when armed-but-not-looping
      ctx.fillRect(lx, 0, lw, h);
      ctx.fillStyle = rgba(p.loopColor, 0.9);
      ctx.fillRect(lx, 0, 2 * dpr, h);
      ctx.fillRect(lx + lw - 2 * dpr, 0, 2 * dpr, h);
    }
    // The "you're looping NOW" state read + its beat length lives in the lane HEADER (a pulsing
    // ⟳ chip in DeckLane), not on the waveform — an opaque pill pinned at the playhead centre
    // collided with the cue flags + the loop-out edge. Here the loop region's brighter fill
    // (active 0.2 vs armed 0.1) + edge bars carry the WHERE; the header chip carries the STATE,
    // and stays visible when the region scrolls off at deep zoom.

    // Waveform — presented from the offscreen layer. A rebuild (the heavy 3×-wide
    // re-rasterise) is forced ONLY when the layer's CONTENT is stale (track/stems/mute/
    // colours) or the view scrolled off it. A pure GEOMETRY change — zoom OR a box resize
    // (expand/collapse a deck, open a dock) — does NOT rebuild on the spot: the cached layer
    // is blit-SCALED (a cheap GPU stretch, both axes) for instant feedback and ONE crisp
    // rebuild is debounced until the geometry settles. That keeps zoom smooth AND makes
    // DECK A/B focus switching feel instant instead of blocking on a full re-rasterise.
    const stemsNow = deck.stemPyramids;
    const maskNow = stemMask(deck, stemsNow);
    const curWin = localWin.current ?? p.windowSec; // the zoom intent, WITHOUT the rate scale
    const m0 = waveMeta.current;
    const contentStale =
      !m0 ||
      m0.pyr !== p.pyramid ||
      m0.stems !== stemsNow ||
      m0.mask !== maskNow ||
      m0.strip !== p.stripColor ||
      m0.accent !== p.accent ||
      m0.freq !== p.freqColors ||
      m0.freqCols !== p.freqLow + p.freqMid + p.freqHigh ||
      m0.viv !== p.vividness ||
      m0.layers !== p.bandLayers ||
      m0.fromDeck !== p.bandFromDeck ||
      m0.stemsDeck !== p.stemsFollowDeck ||
      m0.dbrk !== p.debrick ||
      m0.glow !== p.glow ||
      m0.stemCols !== stemColsKey(p.stemColors);
    // GEOMETRY staleness is a ZOOM or a box-resize — NOT a tempo change. The layer maps track-
    // time→column via colSec, so any rate/scroll is just a blit-scale + shift; only the window
    // (zoom) or the canvas size warrant a fresh rasterise. A big sustained tempo change is the
    // one rate case that coarsens the layer past usefulness — the ratio guard below catches it.
    const geomStale = !!m0 && (m0.w !== w || m0.h !== h || m0.win !== curWin);
    // Window unchanged but a big sustained TEMPO move coarsened/sharpened the layer past
    // usefulness — the one rate case that needs a fresh rasterise (checked only when NOT
    // mid-zoom, so it never pre-empts the smooth-zoom blit-scale below).
    const ratioOff = !!m0 && (secPerPx > m0.colSec * 2.2 || secPerPx < m0.colSec * 0.4);
    // Does the cached layer still span the visible view? (the blit-scale below reads
    // [srcX, srcX+srcW] columns out of [0, ow] — if that runs off either edge the
    // uncovered side draws BLANK.) Used to bail out of the deferred-rebuild path the
    // instant a stale layer stops covering the scrolling view.
    const covers = (mm: WaveMeta | null): boolean => {
      const wcw = waveRef.current?.width ?? 0;
      if (!mm || !wcw) return false;
      const sX = (left - mm.left) / mm.colSec;
      return sX >= -0.5 && sX + trackWindow / mm.colSec <= wcw + 0.5;
    };
    // Track whether the geometry is STILL changing this frame (an ongoing zoom/resize
    // gesture) vs. has settled. draw() runs every frame while the deck plays, so the
    // debounce timer must only be (re)armed when the signature actually changes —
    // otherwise it was cleared+rescheduled 60×/s and NEVER fired during playback, the
    // layer never got rebuilt at the new zoom, and the scrolling view ran off it → the
    // blank stem lanes + waveform-vs-grid drift.
    const gk = curWin + ":" + w + ":" + h;
    const geomChanging = gk !== geomKey.current;
    geomKey.current = gk;
    if (contentStale) {
      rebuildWave(left, trackWindow, secPerPx, curWin, w, h);
    } else if (geomStale && covers(m0)) {
      // Zoom / resize, layer still covers the view: blit-SCALE the cached layer now
      // (below) for instant feedback and debounce ONE crisp rebuild once the geometry
      // SETTLES (re-arm only while the signature keeps changing) — keeps zoom + deck
      // A/B focus snappy without starving the rebuild.
      if (geomChanging) {
        if (rebuildTimer.current) clearTimeout(rebuildTimer.current);
        rebuildTimer.current = window.setTimeout(() => {
          waveMeta.current = null;
          dirty.current = true;
        }, 130);
      }
    } else if (geomStale) {
      // Geometry changed AND the stale layer no longer covers the view (zoomed wider than
      // the layer, or playback scrolled off it before the debounce fired) — rebuild NOW so
      // we never present a blank/partial frame.
      rebuildWave(left, trackWindow, secPerPx, curWin, w, h);
    } else if (deck.jogging) {
      // ACTIVE SCRUB/SCRATCH: the platter sweeps the playhead fast, which the `jumped` test
      // below misreads as a cue/seek discontinuity and FULL-rebuilds the 3×-wide layer EVERY
      // frame — the desktop scrub frame-drops (worse on desktop: faster mouse travel + a
      // bigger/higher-DPR canvas → costlier rebuilds). But the layer already spans ±1 viewport
      // around its centre, so a scratch's back-and-forth is covered — just BLIT it at the new
      // `srcX` offset (below). Only rebuild when the scrub actually leaves the layer's span,
      // which re-centres it (and a contained scratch then never rebuilds at all).
      if (!covers(m0)) rebuildWave(left, trackWindow, secPerPx, curWin, w, h);
    } else if (m0 && (jumped || ratioOff || !shiftToCover(left, trackWindow, m0))) {
      // A discontinuous JUMP (cue/seek/loop — short-circuits before the shift), a tempo that
      // coarsened the layer (ratioOff), or a scroll past the shiftable range — rebuild fresh.
      rebuildWave(left, trackWindow, secPerPx, curWin, w, h);
    }
    const m = waveMeta.current;
    const wc = waveRef.current;
    if (m && wc) {
      // Map view→layer in the layer's OWN units: colSec (seconds/column, folds in the wave-
      // quality downscale) horizontally and the layer's build-time height m.h vertically, so
      // a box resize stretches the old layer correctly until the debounced rebuild lands.
      const srcX = (left - m.left) / m.colSec;
      const srcW = trackWindow / m.colSec;
      ctx.drawImage(wc, srcX, 0, srcW, m.h, 0, 0, w, h);
    }

    // A replacement stem set is computing over the stems already on screen — dim the wave
    // (~half) so it never reads as finished, while the grid / loop / markers / playhead
    // below still draw at full brightness on top (the mixer stays usable). No-op during a
    // first separation: stemPyramids is null then, so the deck just shows the plain mix.
    const sep = p.separating;
    const dimStems = sep != null && sep >= 0 && !!deck.stemPyramids;
    if (dimStems) {
      ctx.fillStyle = "rgba(6,8,12,0.5)";
      ctx.fillRect(0, 0, w, h);
    }

    // Beat grid sized by gridSize. Prefer the DYNAMIC grid (tracked beats that
    // flex with the music) so the lines stay glued to the transients; only fall
    // back to the uniform firstBeat + k·interval comb when no beats were tracked.
    const beatgrid = deck.beatgrid;
    if (beatgrid) {
      const { firstBeat, interval, beats } = beatgrid;
      const dur = deck.duration; // scalar — survives the mobile mix-buffer release
      const right = left + trackWindow;
      const pxPerBeat = (interval / trackWindow) * w;
      const beatsPerBar = beatgrid.beatsPerBar ?? 4;
      const downbeat = beatgrid.downbeat ?? 0;
      // ★ THE GRID NO LONGER RIDES `markerThickness`. That setting says, in its own words, "px
      // width of the cue/loop/hot-cue + phrase marker bars" — a handful of deliberate points per
      // track — and it was ALSO scaling every beat-grid line. So turning cues up to 4 (to make
      // your own cue points findable, which is the only reason to touch it) silently doubled a
      // CONTINUOUS background: bar lines to 4.4px at 95% alpha, beat lines to 2.6px, every 18px.
      // Measured at that zoom, ~17% of the lane was grid. One control was answering two
      // questions — how loud should my markers be, and how loud should the ruler be — and they
      // have opposite answers. The grid is a reference; its weight is fixed and small.
      // gridSize is the snap resolution in BEATS (8 = 2 bars, 1 = a beat, 0.0625 = 1/16
      // beat). Three independent tiers, each LOD-gated by its own pixel spacing:
      //   • BAR  — bold + bar number, every beatsPerBar beats from the downbeat.
      //   • BEAT — medium, every beat.
      //   • SUB  — faint, the sub-beat snap divisions (only when gridSize < 1). These were
      //            missing before: the loop only walked whole beats, so anything finer
      //            than a beat never drew at all.
      // gridSize is the JOG-SKIP grid (⊞ control) — a setting completely independent of the
      // active LOOP's length. Loops go down to 1/16 beat, but skipBeats can sit anywhere
      // (1 beat by default) regardless of what loop is running, so a 1/16 loop zoomed in had
      // no sub-beat line anywhere near fine enough to sit ON — the loop's own IN/OUT bars are
      // exact, but the grid around them stayed coarse, reading as a ghost/mismatched grid at
      // deep zoom. Floor the effective resolution to the loop's own length when it's finer than
      // the skip-grid, so the sub-lines always resolve down to whatever loop is actually running.
      const gs = loop?.active && loop.beats > 0 ? Math.min(p.gridSize, loop.beats) : p.gridSize;
      const subs = gs < 1 ? Math.max(2, Math.round(1 / gs)) : 1; // divisions per beat
      // Adaptive bar LOD: coarsen the bold grid 1→2→4→8→16→32… BARS as you zoom out,
      // so a readable structural (phrase-scale) grid is ALWAYS present — right out to
      // the whole song — instead of the bar lines vanishing once they get too dense.
      // ★ THE LOD LIVES IN gridLod.ts, and it is the SHIPPED path, not a copy the tests shadow.
      // Which tiers draw and how strongly is a claim about a CURVE over zoom ("no in-between state
      // covers too much of the song", "the collapse is a dissolve, not a cut") and a curve cannot
      // be checked from one frame — so it is a pure function, swept in gridLod.test.ts, and that
      // suite also asserts the tiers this replaced FAIL both guarantees, so it can actually fail.
      const lod = gridLod(pxPerBeat, beatsPerBar, subs);
      const { barStep, halfFade, beatFade, subFade, showLabels } = lod;
      const subCol = (f: number) => rgba(p.markerColor, GRID_ALPHA.sub * f);
      const beatCol = (f: number) => rgba(p.markerColor, GRID_ALPHA.beat * f);
      const barCol = (f = 1) => rgba(p.markerColor, GRID_ALPHA.bar * f);

      const vline = (t: number, wpx: number, color: string, top = 0, frac = 1) => {
        if (t < 0 || t > dur || t < left || t > right) return;
        ctx.fillStyle = color;
        ctx.fillRect(toX(t) - (wpx * dpr) / 2, top, Math.max(1, wpx * dpr), h * frac);
      };
      // Time of a (possibly fractional) beat index — interpolated between tracked beats so
      // sub-beat / coarse lines ride the real groove; extrapolated past the ends.
      const beatTimeAt = (f: number) => {
        if (!beats || beats.length < 2) return firstBeat + f * interval;
        const i = Math.floor(f);
        if (i < 0) return beats[0] + f * (beats[1] - beats[0]);
        if (i >= beats.length - 1) {
          const li = beats.length - 1;
          return beats[li] + (f - li) * (beats[li] - beats[li - 1] || interval);
        }
        return beats[i] + (f - i) * (beats[i + 1] - beats[i]);
      };

      // BAR tier — bold lines every `barStep` bars from the downbeat (+ bar number),
      // stepping by whole groups so the whole-song view stays cheap. The label shows
      // the bar number; at coarse steps that reads as 1, 9, 17… (8s) or 1, 17, 33… (16s).
      // ★ THE HALF-STEP GOES DOWN FIRST, UNDERNEATH. Stepping by barStep/2 and drawing the
      // in-between lines at `halfFade` means the tier you are zooming TOWARD dissolves in rather
      // than the whole grid re-pitching itself in one frame.
      const step = barStep > 1 && halfFade > 0 ? barStep / 2 : barStep;
      const leftBar = Math.floor(((left - firstBeat) / interval - downbeat) / beatsPerBar / step) * step;
      if (showLabels) ctx.font = `bold ${9 * dpr}px ui-monospace, monospace`; // set once, not per labelled bar
      for (let b = leftBar - step; ; b += step) {
        const t = beatTimeAt(downbeat + b * beatsPerBar);
        if (t > right) break;
        // A line that belongs to the COARSE tier is solid; a half-step line rides the fade.
        const onCoarse = ((b / barStep) | 0) * barStep === b;
        vline(t, GRID_W.bar, barCol(onCoarse ? 1 : halfFade));
        // Only the coarse tier is ever labelled — numbering the fading half-steps would double
        // the label density for the length of every transition, which is the noisiest possible
        // moment to do it.
        if (onCoarse && showLabels && t >= left && t <= right && t >= 0 && t <= dur) {
          ctx.fillStyle = barCol();
          ctx.fillText(String(b + 1), toX(t) + 3 * dpr, h - 4 * dpr);
        }
      }

      // BEAT + SUB tiers — the bar beats are already drawn above, so these lay only the lighter
      // in-between lines. Both ride a fade rather than a boolean, so they arrive as the zoom
      // makes room for them instead of switching on all at once.
      if (beatFade > 0 || subFade > 0) {
        const bc = beatCol(beatFade);
        const sc = subCol(subFade);
        const drawFine = (i: number, t: number) => {
          if (subFade > 0) for (let j = 1; j < subs; j++) vline(beatTimeAt(i + j / subs), GRID_W.sub, sc);
          const isBar = (((i - downbeat) % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
          if (!isBar && beatFade > 0) vline(t, GRID_W.beat, bc);
        };
        if (beats && beats.length >= 2) {
          let lo = 0;
          let hi = beats.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (beats[mid] < left) lo = mid + 1;
            else hi = mid;
          }
          for (let i = Math.max(0, lo - 1); i < beats.length && beats[i] <= right; i++) drawFine(i, beats[i]);
        } else {
          const k0 = Math.floor((left - firstBeat) / interval) - 1;
          const k1 = Math.ceil((right - firstBeat) / interval) + 1;
          for (let k = k0; k <= k1; k++) drawFine(k, firstBeat + k * interval);
        }
      }

      // Phrase (section) boundaries — variable-length now (structure.ts's chroma SSM), not a
      // fixed 8/16/32-bar comb. Drawn over the bar grid as a bright accent line + the rekordbox-
      // style repeat-section letter (phraseLabels[i], A/B/C/D… — a REPEATED section reuses its
      // earlier letter), so the build/drop/breakdown structure is visible at a glance — ALWAYS,
      // including zoomed out to the whole song. Falls back to a bare P-number for an
      // older-format cached grid analysed before phraseLabels existed.
      const phrases = beatgrid.phrases;
      if (phrases && phrases.length) {
        ctx.font = `bold ${10 * dpr}px ui-monospace, monospace`;
        for (let i = 0; i < phrases.length; i++) {
          const t = phrases[i];
          if (t < left || t > right || t < 0 || t > dur) continue;
          const x = toX(t);
          // ★ THE PHRASE BAR IS A GRID TIER, NOT A MARKER. It used to be `markerThickness + 1`
          // px at 0.85 alpha, which put a CONTINUOUS structural line under the slider whose own
          // description covers the handful of cue/loop bars — and once the beat grid was cut
          // loose from that slider (see gridLod.ts) the phrase bars were left as the heaviest
          // thing on the lane by a factor of six. Fixed weight, sized against the bar line it
          // sits above: strongest tier in the grid, roughly 2× a bar, not a wall.
          const pw = GRID_W.phrase * dpr;
          // Same reason as the rail's: the deck accent IS the waveform's own hue, so a phrase
          // line drawn in it disappears into the loudest part of the track — exactly where the
          // structure you want to see usually is.
          ctx.fillStyle = rgba(p.markerColor, GRID_ALPHA.phrase);
          ctx.fillRect(x - pw / 2, 0, pw, h);
          // ★ THE LETTER IS INK, THE LINE IS A WASH. The label was inheriting the bar's own
          // translucency and sitting on top of the waveform at 10px — thin strokes at 0.72 alpha
          // over a bright master read as "dim and transparent, hard to read". A short dark halo
          // plus a full-strength fill costs about a pixel around each glyph and makes the section
          // letter legible over anything the track throws under it.
          const lbl = beatgrid.phraseLabels?.[i] ?? `P${i + 1}`;
          ctx.lineJoin = "round";
          ctx.miterLimit = 2;
          ctx.lineWidth = 3.5 * dpr;
          ctx.strokeStyle = "rgba(4,6,10,0.92)";
          ctx.strokeText(lbl, x + 4 * dpr, 11 * dpr);
          ctx.fillStyle = p.markerColor;
          ctx.fillText(lbl, x + 4 * dpr, 11 * dpr);
        }
      }
    }

    // Markers.
    const mt = Math.max(1, p.markerThickness || 2); // user marker-bar width (px), centred on the point
    const flag = (t: number, color: string, label?: string) => {
      if (t < left || t > left + trackWindow) return;
      const x = toX(t);
      const tab = 13 * dpr;
      ctx.fillStyle = color;
      ctx.fillRect(x - (mt * dpr) / 2, 0, mt * dpr, h);
      ctx.fillRect(x, 0, tab, tab);
      if (label) {
        ctx.fillStyle = "#06080c";
        ctx.font = `bold ${9.5 * dpr}px ui-monospace, monospace`;
        ctx.fillText(label, x + 2.5 * dpr, 10 * dpr);
      }
    };
    // ★ SAVED LOOPS WERE ON NO SURFACE AT ALL HERE. `deck.hotCues` was drawn and `deck.hotLoops`
    // simply was not — and a pad holds one OR the other, so a bank of saved loops showed as an
    // empty waveform while the pads said they were full. Same grammar the rail uses so the two
    // views describe one thing: the pad's own colour, a faint tint over the loop's SPAN (that is
    // what makes it a loop rather than a cue at a glance), a numbered tab at its IN, and a plain
    // edge at its OUT. Drawn before the live loop and the cues so those still paint on top.
    deck.hotLoops.forEach((l, i) => {
      if (!l || !(l.end > l.start)) return;
      const c = CUE_COLORS[i % CUE_COLORS.length];
      const x0 = Math.max(0, toX(l.start));
      const x1 = Math.min(w, toX(l.end));
      if (x1 > 0 && x0 < w && x1 > x0) {
        ctx.fillStyle = rgba(c, 0.12);
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
      flag(l.start, c, String(i + 1));
      // The OUT edge gets a line but no tab: the span already says where it ends, and a second
      // numbered tab per loop would double the furniture for no extra information.
      if (l.end >= left && l.end <= left + trackWindow) {
        ctx.fillStyle = rgba(c, 0.8);
        ctx.fillRect(toX(l.end) - (mt * dpr) / 4, 0, Math.max(1, (mt * dpr) / 2), h);
      }
    });
    if (loop && loop.end > loop.start) {
      flag(loop.start, p.loopColor, "▶");
      flag(loop.end, p.loopColor, "◀");
    }
    if (deck.loopInPoint != null) flag(deck.loopInPoint, p.loopColor);
    if (deck.cuePoint != null) flag(deck.cuePoint, "#ff8a3c", "C");
    deck.hotCues.forEach((t, i) => {
      if (t != null) flag(t, CUE_COLORS[i % CUE_COLORS.length], String(i + 1));
    });

    // Centre playhead.
    ctx.fillStyle = p.selectorColor;
    ctx.fillRect(w / 2 - dpr, 0, 2 * dpr, h);

    // (The "separating" % is shown ONCE, in the deck header — the dim above is the only
    // on-waveform cue that a replacement stem set is pending.)
  };

  // One perpetual rAF: composites while the deck plays/jogs or when something
  // changed (dirty). Idle frames just reschedule — no React reconciliation.
  useEffect(() => {
    let raf = 0;
    // Async per-stem envelopes finished building (DSP or neural) → request a redraw,
    // even while paused; the next frame re-rasterises into the quad lanes.
    deck.onStemPyramids = () => {
      dirty.current = true;
    };
    const loop = () => {
      if (deck.visualPlaying || deck.jogging || deck.adjusting || dirty.current) {
        dirty.current = false;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      deck.onStemPyramids = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck]);

  const releaseScrub = () => {
    if (drag.current?.started) {
      drag.current.started = false;
      onScrubEnd();
    }
  };
  const trackWindowNow = () => (localWin.current ?? props.windowSec) * Math.max(deck.rate, 0.01);

  return (
    <div className="wv-wrap">
      <canvas
        ref={canvasRef}
        className="waveform"
        style={{ touchAction: "none" }}
        onWheel={(e) => {
          // In loop-boundary adjust mode the wheel steps the edge (routed downstream
          // via onNeedleDrop → adjustStep) — no Shift needed, that's the mode's point.
          // A plain wheel zooms the view. Shift+wheel is a PITCH-BEND: while playing it
          // momentarily pushes/pulls the tempo (beat-match nudge), while paused deck.bend
          // frame-searches. Window-INDEPENDENT scale (≈0.2 s roll per mouse notch) so the
          // bend strength doesn't change with zoom; the engine clamps + decays it.
          if (deck.adjusting) {
            onNeedleDrop((e.deltaY / 700) * trackWindowNow());
          } else if (e.shiftKey) {
            onBend((e.deltaY / 700) * 0.2);
          } else if (props.wheelSeeks) {
            // Wheel-seek mode (Settings): a plain wheel scrubs the playhead instead of
            // zooming; window-proportional so the feel is constant at any zoom. Hold
            // Ctrl/⌘ to zoom on demand (the inverse of the default mode).
            if (e.ctrlKey || e.metaKey) applyZoom(clampWin((localWin.current ?? props.windowSec) * (e.deltaY > 0 ? 1.25 : 0.8)));
            else onNeedleDrop((e.deltaY / 700) * trackWindowNow());
          } else {
            applyZoom(clampWin((localWin.current ?? props.windowSec) * (e.deltaY > 0 ? 1.25 : 0.8)));
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pinch.current.set(e.pointerId, e.clientX);
          if (pinch.current.size === 1) {
            const rect = e.currentTarget.getBoundingClientRect();
            drag.current = { x: e.clientX, started: false };
            tap.current = { startX: e.clientX, relX: e.clientX - rect.left, w: rect.width };
            clearLongPress();
            longPress.current = window.setTimeout(() => {
              longPress.current = undefined;
              // Still down, never turned into a real drag → a deliberate hold, not a tap-seek.
              if (drag.current && !drag.current.started) {
                drag.current = null;
                tap.current = null; // consumed — the eventual pointerup must not ALSO seek
                view.current.onReleaseBrake();
              }
            }, LONG_PRESS_MS);
          } else if (pinch.current.size === 2) {
            releaseScrub();
            tap.current = null;
            clearLongPress(); // a 2nd finger landing means this was never a single-finger hold
            twoFinger.current = { moved: false };
            const xs = [...pinch.current.values()];
            pinchDist.current = Math.abs(xs[0] - xs[1]);
            drag.current = null;
          } else {
            twoFinger.current = null; // a 3rd finger down: no longer a clean two-finger gesture
          }
        }}
        onPointerMove={(e) => {
          if (pinch.current.has(e.pointerId)) pinch.current.set(e.pointerId, e.clientX);
          if (pinch.current.size === 2) {
            const xs = [...pinch.current.values()];
            const d = Math.abs(xs[0] - xs[1]);
            if (pinchDist.current > 0) {
              if (twoFinger.current && Math.abs(d - pinchDist.current) > MOVE_PX) twoFinger.current.moved = true;
              applyZoom(clampWin((localWin.current ?? props.windowSec) * (pinchDist.current / d)));
            }
            pinchDist.current = d;
            return;
          }
          const dr = drag.current;
          if (!dr) return;
          if (!dr.started) {
            if (tap.current && Math.abs(e.clientX - tap.current.startX) <= MOVE_PX) return;
            dr.started = true;
            tap.current = null;
            clearLongPress(); // a real scratch starting cancels the pending hold-to-brake
            dr.x = e.clientX;
            onScrubStart();
          }
          // Replay every sub-frame pointer sample the browser coalesced into this
          // event. A mouse reports at 125–1000 Hz but pointermove is batched to the
          // display refresh (~60 Hz), so without this most of the motion is dropped
          // on desktop — which is exactly why the jog felt coarser than touch. Each
          // recovered sample drives the scratch worklet directly (see Deck.scrubMove).
          const native = e.nativeEvent;
          const coalesced =
            typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
          const samples = coalesced.length ? coalesced : [native];
          // Cached CSS width (device px ÷ dpr) — avoids a forced layout reflow on every scrub
          // move (getBoundingClientRect was the per-move reflow; size comes from the RO instead).
          const w = sizeRef.current.w / sizeRef.current.dpr;
          const win = trackWindowNow();
          for (const s of samples) {
            const dxPx = s.clientX - dr.x;
            dr.x = s.clientX;
            onScrub((-dxPx / w) * win);
          }
        }}
        onPointerUp={(e) => {
          pinch.current.delete(e.pointerId);
          if (pinch.current.size < 2) pinchDist.current = 0;
          if (pinch.current.size === 0) {
            clearLongPress();
            const t = tap.current;
            const dr = drag.current;
            const tf = twoFinger.current;
            tap.current = null;
            drag.current = null;
            twoFinger.current = null;
            if (dr?.started) {
              dr.started = false;
              onScrubEnd();
            } else if (tf) {
              if (!tf.moved) view.current.onCensorToggle();
            } else if (t) {
              onNeedleDrop((t.relX / t.w - 0.5) * trackWindowNow());
            }
          }
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          releaseScrub();
          clearLongPress();
          twoFinger.current = null;
          drag.current = null;
          tap.current = null;
          pinch.current.clear();
          pinchDist.current = 0;
        }}
      />
    </div>
  );
}

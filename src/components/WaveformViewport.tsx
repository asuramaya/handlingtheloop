import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import type { Pyramid, PyramidLevel } from "@htl/analysis";

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
  gridSize: number;
  windowSec: number; // REAL seconds across the view (shared by both decks)
  onZoom: (nextWindowSec: number) => void;
  onScrubStart: () => void;
  onScrub: (deltaSeconds: number) => void;
  onScrubEnd: () => void;
  onNeedleDrop: (deltaSeconds: number) => void;
}

const CUE_COLORS = ["#ff5d73", "#ffb13c", "#ffe24a", "#6ee7a8", "#36c2ff", "#7b9cff", "#c77bff", "#ff7bd0"];

// Per-stem waveform colours, stacked centre-out in this order (drums innermost).
const STEM_ORDER = ["drums", "bass", "vocals", "other"] as const;
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

// Perceptual amplitude curve: music peaks well below full scale, so a linear map leaves
// every waveform a thin sliver in a sea of black. A gentle gain + soft knee lifts quiet
// passages so they have body, while loud peaks ease into the lane edge instead of clipping
// flat. Sign-preserving so the signed waveform shape is kept.
function shape(v: number): number {
  const g = v * 1.7;
  const a = Math.abs(g);
  // soft-clip above 0.8 so peaks compress smoothly toward ±1 rather than slamming flat
  const y = a <= 0.8 ? a : 0.8 + (1 - 0.8) * (1 - Math.exp(-(a - 0.8) / (1 - 0.8)));
  return v < 0 ? -y : y;
}

// What the offscreen waveform layer currently holds — rebuilt only when one of
// these changes (zoom/track/stems/mute/size/colour) or the view scrolls off it.
interface WaveMeta {
  left: number;
  span: number;
  secPerPx: number;
  w: number;
  h: number;
  pyr: Pyramid | null;
  stems: Record<string, Pyramid> | null;
  mask: string;
  strip: string;
  accent: string;
  stemCols: string; // per-stem colour overrides, joined — recolour → re-rasterise
}

export function WaveformViewport(props: WaveformViewportProps) {
  const { deck, onZoom, onScrubStart, onScrub, onScrubEnd, onNeedleDrop } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // `started` flips true only once the finger has moved past MOVE_PX — until then
  // it's a potential tap (instant seek), not a scrub.
  const drag = useRef<{ x: number; started: boolean } | null>(null);
  const tap = useRef<{ startX: number; relX: number; w: number } | null>(null);
  const pinch = useRef<Map<number, number>>(new Map());
  const pinchDist = useRef(0);
  const bgRef = useRef("#08080d"); // cached lane bg (--surface)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 }); // cached device-px size (no per-frame reflow)
  const dirty = useRef(true); // request one composite (set on any React render / resize)
  const waveRef = useRef<HTMLCanvasElement | null>(null); // offscreen rasterised waveform
  const waveMeta = useRef<WaveMeta | null>(null);
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
    const dpr = window.devicePixelRatio || 1;
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    const changed = el.width !== w || el.height !== h;
    if (changed) {
      el.width = w;
      el.height = h;
    }
    sizeRef.current = { w, h, dpr };
    waveMeta.current = null; // force the offscreen layer to rebuild at the new size
    dirty.current = true;
    // Assigning el.width above BLANKS the canvas. ResizeObserver fires before
    // paint, so redraw synchronously NOW — otherwise the cleared canvas paints for
    // one frame and the (stem-coloured) waveform visibly blinks out and back when a
    // dock (Library/Search) opens and squeezes the board.
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
  // Re-read the themed background + invalidate the layer on theme / zoom changes.
  useEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.accent, props.stripColor, props.loopColor, props.markerColor, props.selectorColor, stemColsKey(props.stemColors)]);

  const clampWin = (wsec: number) => {
    const dur = deck.buffer?.duration ?? 1;
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
    const stems = deck.stemPyramids;
    const lo = new Float32Array(ow);
    const hi = new Float32Array(ow);

    // ONE signed-envelope renderer, used identically for the mix and every stem lane. The
    // shape is the same at all zooms — it just compresses sideways as you zoom out and
    // resolves down to individual samples as you zoom in. `srcSr`/`raw`/`lodPy` pick the
    // cheapest source for the zoom (LOD when out, raw PCM when in); the visual is identical.
    const paintWave = (
      srcSr: number,
      raw: Float32Array | null,
      raw1: Float32Array | null,
      lodPy: Pyramid | null,
      yc: number,
      amp: number,
      color: string,
    ) => {
      if (raw) envelope(raw, raw1, srcSr, rLeft, secPerPx, ow, lo, hi, null);
      else if (lodPy) envelope(null, null, srcSr, rLeft, secPerPx, ow, lo, hi, pickLevel(lodPy, secPerPx * srcSr));
      else return;
      const path = new Path2D();
      path.moveTo(0, yc - shape(hi[0]) * amp);
      for (let x = 1; x < ow; x++) path.lineTo(x, yc - shape(hi[x]) * amp); // top edge (max) →
      for (let x = ow - 1; x >= 0; x--) path.lineTo(x, yc - shape(lo[x]) * amp); // bottom edge (min) ←
      path.closePath();
      ctx.fillStyle = color;
      ctx.fill(path);
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
        const color = p.stemColors[name] || STEM_COLORS[name] || p.accent;
        // Brightness tracks the stem's KNOB level (muted/0 → dim, unity → full).
        const amp = deck.stemActive(name) ? deck.stemLevel(name) : 0;
        const alpha = 0.16 + 0.84 * Math.min(1, amp);
        paintWave(ssr, raw, null, py, (li + 0.5) * laneH, half, rgba(color, alpha));
      }
    } else if (deck.buffer && p.pyramid) {
      // ONE collapsed waveform — no stems, or while a split's per-stem envelopes are
      // still building. Same renderer, full height, single colour.
      const bsr = deck.buffer.sampleRate;
      const raw = secPerPx * bsr < RAW_SPP ? deck.buffer.getChannelData(0) : null;
      const raw1 = raw && deck.buffer.numberOfChannels > 1 ? deck.buffer.getChannelData(1) : null;
      paintWave(bsr, raw, raw1, p.pyramid, mid, mid * 0.95, p.stripColor || p.accent);
    }
  };

  // Rasterise a fresh offscreen layer (3× viewport wide) centred on the view.
  // This is the only place the heavy per-pixel loop runs.
  const rebuildWave = (left: number, tw: number, secPerPx: number, w: number, h: number) => {
    const p = view.current;
    const stems = deck.stemPyramids;
    const mask = stemMask(deck, stems);
    const span = tw * 3;
    const waveLeft = left - tw;
    const ow = w * 3;
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
    rasterize(wctx, waveLeft, secPerPx, ow, h);
    waveMeta.current = { left: waveLeft, span, secPerPx, w, h, pyr: p.pyramid, stems, mask, strip: p.stripColor, accent: p.accent, stemCols: stemColsKey(p.stemColors) };
    if (rebuildTimer.current) {
      clearTimeout(rebuildTimer.current);
      rebuildTimer.current = 0;
    }
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
    if (!p.pyramid || !deck.buffer) return;

    const pos = deck.position();
    const r = Math.max(deck.rate, 0.01);
    const trackWindow = (localWin.current ?? p.windowSec) * r;
    const left = pos - trackWindow / 2;
    const secPerPx = trackWindow / w;
    const toX = (t: number) => ((t - left) / trackWindow) * w;

    // Loop region — tinted fill + bright edge bars.
    const loop = deck.loop;
    if (loop && loop.end > loop.start) {
      const lx = toX(loop.start);
      const lw = (loop.end - loop.start) / secPerPx;
      ctx.fillStyle = rgba(p.loopColor, 0.2);
      ctx.fillRect(lx, 0, lw, h);
      ctx.fillStyle = rgba(p.loopColor, 0.9);
      ctx.fillRect(lx, 0, 2 * dpr, h);
      ctx.fillRect(lx + lw - 2 * dpr, 0, 2 * dpr, h);
    }

    // Waveform — presented from the offscreen layer. Rebuild it (the heavy part)
    // only when a static input changed or the view scrolled off it. While ZOOMING
    // (scale changed but still on-layer), DON'T rasterise per wheel tick — blit the
    // cached layer SCALED for instant feedback and schedule ONE crisp rebuild once
    // zooming settles. That keeps zoom smooth without 3×-wide re-rasterises.
    const stemsNow = deck.stemPyramids;
    const maskNow = stemMask(deck, stemsNow);
    const m0 = waveMeta.current;
    const staleStatic =
      !m0 ||
      m0.w !== w ||
      m0.h !== h ||
      m0.pyr !== p.pyramid ||
      m0.stems !== stemsNow ||
      m0.mask !== maskNow ||
      m0.strip !== p.stripColor ||
      m0.accent !== p.accent ||
      m0.stemCols !== stemColsKey(p.stemColors);
    const scrolledOff = !!m0 && (left < m0.left + trackWindow * 0.1 || left + trackWindow > m0.left + m0.span - trackWindow * 0.1);
    if (staleStatic || scrolledOff) {
      rebuildWave(left, trackWindow, secPerPx, w, h);
    } else if (m0.secPerPx !== secPerPx) {
      if (rebuildTimer.current) clearTimeout(rebuildTimer.current);
      rebuildTimer.current = window.setTimeout(() => {
        waveMeta.current = null;
        dirty.current = true;
      }, 130);
    }
    const m = waveMeta.current;
    const wc = waveRef.current;
    if (m && wc) {
      const srcX = (left - m.left) / m.secPerPx;
      const srcW = trackWindow / m.secPerPx; // == w at native scale; scales the blit while zooming
      ctx.drawImage(wc, srcX, 0, srcW, h, 0, 0, w, h);
    }

    // Beat grid sized by gridSize. Prefer the DYNAMIC grid (tracked beats that
    // flex with the music) so the lines stay glued to the transients; only fall
    // back to the uniform firstBeat + k·interval comb when no beats were tracked.
    const beatgrid = deck.beatgrid;
    if (beatgrid) {
      const { firstBeat, interval, beats } = beatgrid;
      const dur = deck.buffer.duration;
      const right = left + trackWindow;
      const pxPerBeat = (interval / trackWindow) * w;
      const beatsPerBar = beatgrid.beatsPerBar ?? 4;
      const downbeat = beatgrid.downbeat ?? 0;
      // gridSize is the snap resolution in BEATS (8 = 2 bars, 1 = a beat, 0.0625 = 1/16
      // beat). Three independent tiers, each LOD-gated by its own pixel spacing:
      //   • BAR  — bold + bar number, every beatsPerBar beats from the downbeat.
      //   • BEAT — medium, every beat.
      //   • SUB  — faint, the sub-beat snap divisions (only when gridSize < 1). These were
      //            missing before: the loop only walked whole beats, so anything finer
      //            than a beat never drew at all.
      const gs = p.gridSize;
      const subs = gs < 1 ? Math.max(2, Math.round(1 / gs)) : 1; // divisions per beat
      const pxPerBar = pxPerBeat * beatsPerBar;
      // Adaptive bar LOD: coarsen the bold grid 1→2→4→8→16→32… BARS as you zoom out,
      // so a readable structural (phrase-scale) grid is ALWAYS present — right out to
      // the whole song — instead of the bar lines vanishing once they get too dense.
      const MIN_BAR_PX = 22;
      let barStep = 1;
      while (pxPerBar * barStep < MIN_BAR_PX) barStep *= 2;
      const fine = barStep === 1; // tight enough to also show individual beats / subs
      const showSub = fine && subs > 1 && pxPerBeat / subs >= 4;
      const showBeat = fine && pxPerBeat >= 9;
      const showLabels = pxPerBar * barStep >= 26;
      const subCol = rgba(p.markerColor, 0.16);
      const beatCol = rgba(p.markerColor, 0.42);
      const barCol = rgba(p.markerColor, 0.95);

      const vline = (t: number, wpx: number, color: string) => {
        if (t < 0 || t > dur || t < left || t > right) return;
        ctx.fillStyle = color;
        ctx.fillRect(toX(t) - (wpx * dpr) / 2, 0, Math.max(1, wpx * dpr), h);
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
      const leftBar = Math.floor(((left - firstBeat) / interval - downbeat) / beatsPerBar / barStep) * barStep;
      for (let b = leftBar - barStep; ; b += barStep) {
        const t = beatTimeAt(downbeat + b * beatsPerBar);
        if (t > right) break;
        vline(t, 2.2, barCol);
        if (showLabels && t >= left && t <= right && t >= 0 && t <= dur) {
          ctx.fillStyle = barCol;
          ctx.font = `bold ${9 * dpr}px ui-monospace, monospace`;
          ctx.fillText(String(b + 1), toX(t) + 3 * dpr, h - 4 * dpr);
        }
      }

      // BEAT + SUB tiers — only at fine zoom (barStep === 1); the bar beats are already
      // drawn bold above, so skip them here and just lay the lighter in-between lines.
      if (showBeat || showSub) {
        const drawFine = (i: number, t: number) => {
          if (showSub) for (let j = 1; j < subs; j++) vline(beatTimeAt(i + j / subs), 1, subCol);
          const isBar = (((i - downbeat) % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
          if (!isBar && showBeat) vline(t, 1.3, beatCol);
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

      // Phrase boundaries — the 8/16/32-bar section starts. Drawn over the bar grid
      // as a bright accent line + a phrase number, so the build/drop/breakdown
      // structure is visible at a glance — ALWAYS, including zoomed out to the whole song.
      const phrases = beatgrid.phrases;
      if (phrases && phrases.length) {
        ctx.font = `bold ${10 * dpr}px ui-monospace, monospace`;
        for (let i = 0; i < phrases.length; i++) {
          const t = phrases[i];
          if (t < left || t > right || t < 0 || t > dur) continue;
          const x = toX(t);
          ctx.fillStyle = rgba(p.accent, 0.85);
          ctx.fillRect(x - dpr, 0, 3 * dpr, h);
          ctx.fillText(`P${i + 1}`, x + 4 * dpr, 11 * dpr);
        }
      }
    }

    // Markers.
    const flag = (t: number, color: string, label?: string) => {
      if (t < left || t > left + trackWindow) return;
      const x = toX(t);
      const tab = 13 * dpr;
      ctx.fillStyle = color;
      ctx.fillRect(x - dpr, 0, 2 * dpr, h);
      ctx.fillRect(x, 0, tab, tab);
      if (label) {
        ctx.fillStyle = "#06080c";
        ctx.font = `bold ${9.5 * dpr}px ui-monospace, monospace`;
        ctx.fillText(label, x + 2.5 * dpr, 10 * dpr);
      }
    };
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
      if (deck.playing || deck.jogging || deck.adjusting || dirty.current) {
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
          // Otherwise a plain wheel zooms the view; Shift+wheel jogs the playhead
          // (scrubs by a slice of the visible window per tick). needleDrop is a relative seek.
          if (deck.adjusting || e.shiftKey) {
            onNeedleDrop((e.deltaY / 700) * trackWindowNow());
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
          } else if (pinch.current.size === 2) {
            releaseScrub();
            tap.current = null;
            const xs = [...pinch.current.values()];
            pinchDist.current = Math.abs(xs[0] - xs[1]);
            drag.current = null;
          }
        }}
        onPointerMove={(e) => {
          if (pinch.current.has(e.pointerId)) pinch.current.set(e.pointerId, e.clientX);
          if (pinch.current.size === 2) {
            const xs = [...pinch.current.values()];
            const d = Math.abs(xs[0] - xs[1]);
            if (pinchDist.current > 0) applyZoom(clampWin((localWin.current ?? props.windowSec) * (pinchDist.current / d)));
            pinchDist.current = d;
            return;
          }
          const dr = drag.current;
          if (!dr) return;
          const rect = e.currentTarget.getBoundingClientRect();
          if (!dr.started) {
            if (tap.current && Math.abs(e.clientX - tap.current.startX) <= MOVE_PX) return;
            dr.started = true;
            tap.current = null;
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
          const w = rect.width;
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
            const t = tap.current;
            const dr = drag.current;
            tap.current = null;
            drag.current = null;
            if (dr?.started) {
              dr.started = false;
              onScrubEnd();
            } else if (t) {
              onNeedleDrop((t.relX / t.w - 0.5) * trackWindowNow());
            }
          }
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          releaseScrub();
          drag.current = null;
          tap.current = null;
          pinch.current.clear();
          pinchDist.current = 0;
        }}
      />
    </div>
  );
}

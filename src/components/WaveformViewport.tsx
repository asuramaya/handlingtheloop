import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import type { Pyramid } from "@htl/analysis";

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

// hex (#rgb / #rrggbb) → rgba() string at the given alpha; passes other inputs
// through unchanged so named/rgb colours still work.
function rgba(hex: string, a: number): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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
  }, [props.accent, props.stripColor, props.loopColor, props.markerColor, props.selectorColor]);

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
    const sr = p.pyramid?.sampleRate ?? 44100;
    const samplesPerPx = secPerPx * sr;
    const mid = h / 2;
    const stems = deck.stemPyramids;

    if (stems) {
      const names = STEM_ORDER.filter((n) => stems[n] && deck.stemActive(n));
      if (!names.length) return;
      const ssr = stems[names[0]]?.sampleRate ?? sr;
      const sPerPx = secPerPx * ssr;
      const pickLevel = (py: Pyramid) => {
        let lvl = py.levels[0];
        for (const l of py.levels) {
          if (l.bucket <= sPerPx) lvl = l;
          else break;
        }
        return lvl;
      };
      const layers = names.map((n) => ({ n, lvl: pickLevel(stems[n]) }));
      const SCALE = 0.55;
      const paths = layers.map(() => new Path2D());
      for (let x = 0; x < ow; x++) {
        const s0 = (rLeft + x * secPerPx) * ssr;
        let up = 0;
        let dn = 0;
        for (let li = 0; li < layers.length; li++) {
          const lvl = layers[li].lvl;
          const B = lvl.bucket;
          let b0 = Math.floor(s0 / B);
          let b1 = Math.floor((s0 + sPerPx) / B);
          if (b1 < 0 || b0 >= lvl.min.length) continue;
          b0 = Math.max(0, b0);
          b1 = Math.min(lvl.min.length - 1, b1);
          let lo = 1;
          let hi = -1;
          for (let b = b0; b <= b1; b++) {
            if (lvl.min[b] < lo) lo = lvl.min[b];
            if (lvl.max[b] > hi) hi = lvl.max[b];
          }
          if (hi < lo) continue;
          const hpx = Math.max(hi, -lo) * mid * 0.95 * SCALE;
          if (hpx < 0.3) continue;
          paths[li].rect(x, mid - up - hpx, 1, hpx);
          paths[li].rect(x, mid + dn, 1, hpx);
          up += hpx;
          dn += hpx;
        }
      }
      for (let li = 0; li < layers.length; li++) {
        ctx.fillStyle = STEM_COLORS[layers[li].n] ?? p.accent;
        ctx.fill(paths[li]);
      }
    } else if (samplesPerPx >= 256 && p.pyramid) {
      let lvl = p.pyramid.levels[0];
      for (const l of p.pyramid.levels) {
        if (l.bucket <= samplesPerPx) lvl = l;
        else break;
      }
      const B = lvl.bucket;
      for (let x = 0; x < ow; x++) {
        const s0 = (rLeft + x * secPerPx) * sr;
        let b0 = Math.floor(s0 / B);
        let b1 = Math.floor((s0 + samplesPerPx) / B);
        if (b1 < 0 || b0 >= lvl.min.length) continue;
        b0 = Math.max(0, b0);
        b1 = Math.min(lvl.min.length - 1, b1);
        let lo = 1;
        let hi = -1;
        let ls = 0;
        let ms = 0;
        let hs = 0;
        let c = 0;
        for (let b = b0; b <= b1; b++) {
          if (lvl.min[b] < lo) lo = lvl.min[b];
          if (lvl.max[b] > hi) hi = lvl.max[b];
          ls += lvl.low[b];
          ms += lvl.mid[b];
          hs += lvl.high[b];
          c++;
        }
        if (c === 0) continue;
        const L = ls / c;
        const M = ms / c;
        const H = hs / c;
        const sum = L + M + H + 1e-6;
        ctx.fillStyle = `rgb(${(L * 40 + M * 245 + H * 220) / sum},${(L * 105 + M * 155 + H * 238) / sum},${(L * 235 + M * 45 + H * 255) / sum})`;
        ctx.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
    } else if (deck.buffer) {
      const ch0 = deck.buffer.getChannelData(0);
      const ch1 = deck.buffer.numberOfChannels > 1 ? deck.buffer.getChannelData(1) : null;
      ctx.fillStyle = p.stripColor || p.accent;
      for (let x = 0; x < ow; x++) {
        const i0 = Math.max(0, Math.floor((rLeft + x * secPerPx) * sr));
        const i1 = Math.min(ch0.length, Math.ceil((rLeft + (x + 1) * secPerPx) * sr));
        if (i1 <= i0) continue;
        let lo = 1;
        let hi = -1;
        for (let i = i0; i < i1; i++) {
          const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
          if (s < lo) lo = s;
          if (s > hi) hi = s;
        }
        ctx.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
    }
  };

  // Rasterise a fresh offscreen layer (3× viewport wide) centred on the view.
  // This is the only place the heavy per-pixel loop runs.
  const rebuildWave = (left: number, tw: number, secPerPx: number, w: number, h: number) => {
    const p = view.current;
    const stems = deck.stemPyramids;
    const mask = stems ? STEM_ORDER.filter((n) => stems[n] && deck.stemActive(n)).join(",") : "";
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
    waveMeta.current = { left: waveLeft, span, secPerPx, w, h, pyr: p.pyramid, stems, mask, strip: p.stripColor, accent: p.accent };
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
    const maskNow = stemsNow ? STEM_ORDER.filter((n) => stemsNow[n] && deck.stemActive(n)).join(",") : "";
    const m0 = waveMeta.current;
    const staleStatic =
      !m0 ||
      m0.w !== w ||
      m0.h !== h ||
      m0.pyr !== p.pyramid ||
      m0.stems !== stemsNow ||
      m0.mask !== maskNow ||
      m0.strip !== p.stripColor ||
      m0.accent !== p.accent;
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
      const pxPerBeat = (interval / trackWindow) * w; // LOD gate (representative)
      const pxPerCell = pxPerBeat * p.gridSize;
      const dur = deck.buffer.duration;
      const right = left + trackWindow;
      const showBeats = p.gridSize > 1 && pxPerBeat >= 6;
      const showCells = pxPerCell >= 5;
      const showLabels = pxPerCell >= 30;
      const beatColor = rgba(p.markerColor, 0.22);
      const barColor = rgba(p.markerColor, 0.9);

      const drawLine = (t: number, bar: boolean, label?: string) => {
        if (t < 0 || t > dur) return;
        const x = toX(t);
        if (bar) {
          ctx.fillStyle = barColor;
          ctx.fillRect(x, 0, 2 * dpr, h);
          if (label != null && showLabels) {
            ctx.font = `${9 * dpr}px ui-monospace, monospace`;
            ctx.fillText(label, x + 3 * dpr, h - 4 * dpr);
          }
        } else {
          ctx.fillStyle = beatColor;
          ctx.fillRect(x, 0, 1 * dpr, h);
        }
      };

      if (beats && beats.length >= 2 && (showBeats || showCells)) {
        // First visible beat index (binary search), then walk forward.
        let lo = 0;
        let hi = beats.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (beats[mid] < left) lo = mid + 1;
          else hi = mid;
        }
        // Bold cells start on the detected downbeat (the musical "1"), so bar lines
        // and bar numbers are musically correct, not anchored to beats[0].
        const gs = p.gridSize;
        const phase = (((beatgrid.downbeat ?? 0) % gs) + gs) % gs;
        for (let i = lo; i < beats.length && beats[i] <= right; i++) {
          const isBar = (((i - phase) % gs) + gs) % gs === 0;
          if (isBar) {
            if (showCells) drawLine(beats[i], true, String(Math.floor((i - phase) / gs)));
          } else if (showBeats) {
            drawLine(beats[i], false);
          }
        }
      } else {
        // Uniform fallback (no tracked beats).
        const cell = interval * p.gridSize;
        if (showBeats) {
          let kb = Math.ceil((left - firstBeat) / interval);
          for (let t = firstBeat + kb * interval; t <= right; kb++, t = firstBeat + kb * interval) {
            if (kb % p.gridSize !== 0) drawLine(t, false);
          }
        }
        if (showCells) {
          let kc = Math.ceil((left - firstBeat) / cell);
          for (let t = firstBeat + kc * cell; t <= right; kc++, t = firstBeat + kc * cell) {
            drawLine(t, true, String(kc));
          }
        }
      }

      // Phrase boundaries — the 8/16/32-bar section starts. Drawn over the bar grid
      // as a bright accent line + a phrase number, so the build/drop/breakdown
      // structure is visible at a glance and you can line a mix up to a phrase.
      const phrases = beatgrid.phrases;
      if (phrases && phrases.length && showCells) {
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
    const loop = () => {
      if (deck.playing || deck.jogging || dirty.current) {
        dirty.current = false;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
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
          // Shift+wheel zooms the view; a plain wheel jogs the playhead (scrubs by a
          // slice of the visible window per tick). needleDrop is a relative seek.
          if (e.shiftKey) {
            applyZoom(clampWin((localWin.current ?? props.windowSec) * (e.deltaY > 0 ? 1.25 : 0.8)));
          } else {
            onNeedleDrop((e.deltaY / 700) * trackWindowNow());
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
          const dxPx = e.clientX - dr.x;
          dr.x = e.clientX;
          onScrub((-dxPx / rect.width) * trackWindowNow());
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

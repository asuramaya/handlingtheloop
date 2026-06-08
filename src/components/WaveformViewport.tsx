import { useEffect, useRef } from "react";
import type { Beatgrid, Pyramid } from "../audio/analyze";

interface WaveformViewportProps {
  pyramid: Pyramid | null;
  buffer: AudioBuffer | null;
  position: number; // playhead seconds (pinned at center)
  duration: number;
  rate: number; // playback rate — the x-axis is REAL time, so beats at the same
  // effective BPM line up between decks even when native BPM differs
  beatgrid: Beatgrid | null;
  loop: { start: number; end: number } | null;
  cuePoint: number | null;
  hotCues: (number | null)[];
  loopInPoint: number | null;
  accent: string;
  windowSec: number; // REAL seconds shown across the view (shared by both decks)
  onZoom: (nextWindowSec: number) => void;
  onScrubStart: () => void;
  onScrub: (deltaSeconds: number) => void;
  onScrubEnd: () => void;
}

const CUE_COLORS = ["#ff5d73", "#ffb13c", "#ffe24a", "#6ee7a8", "#36c2ff", "#7b9cff", "#c77bff", "#ff7bd0"];

export function WaveformViewport({
  pyramid,
  buffer,
  position,
  duration,
  rate,
  beatgrid,
  loop,
  cuePoint,
  hotCues,
  loopInPoint,
  accent,
  windowSec,
  onZoom,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: WaveformViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number } | null>(null);
  const scrubbing = useRef(false);
  const pinch = useRef<Map<number, number>>(new Map());
  const pinchDist = useRef(0);
  const endScrub = () => {
    if (scrubbing.current) {
      scrubbing.current = false;
      onScrubEnd();
    }
  };

  const sr = pyramid?.sampleRate ?? 44100;
  const clampWin = (wsec: number) => Math.max(0.003, Math.min(Math.max(1, duration || 1) * 1.1, wsec));

  // REAL-time window -> track-time window (a faster deck covers more track per
  // real second), so a given effective BPM draws at the same pixel spacing.
  const r = Math.max(rate, 0.01);
  const trackWindow = windowSec * r;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width * dpr);
    const h = Math.floor(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#08090d";
    ctx.fillRect(0, 0, w, h);
    if (!pyramid || !buffer) return;

    const mid = h / 2;
    const left = position - trackWindow / 2;
    const secPerPx = trackWindow / w;
    const samplesPerPx = secPerPx * sr;
    const toX = (t: number) => ((t - left) / trackWindow) * w;

    // Loop region.
    if (loop && loop.end > loop.start) {
      ctx.fillStyle = "rgba(110,231,168,0.14)";
      ctx.fillRect(toX(loop.start), 0, (loop.end - loop.start) / secPerPx, h);
    }

    // Adaptive beat grid (beat -> bar -> phrase) with bar numbers.
    if (beatgrid) {
      const { firstBeat, interval } = beatgrid;
      const pxPerBeat = (interval / trackWindow) * w;
      let step = 64;
      for (const s of [1, 4, 16, 64]) {
        if (pxPerBeat * s >= 12) {
          step = s;
          break;
        }
      }
      let k = Math.ceil((left - firstBeat) / interval / step) * step;
      for (;;) {
        const t = firstBeat + k * interval;
        if (t > left + trackWindow) break;
        if (t >= 0 && t <= duration) {
          const x = toX(t);
          const km = ((k % 16) + 16) % 16;
          const phrase = km === 0;
          const bar = km % 4 === 0;
          ctx.fillStyle = phrase ? "rgba(255,210,80,0.75)" : bar ? "rgba(255,210,80,0.4)" : "rgba(255,255,255,0.14)";
          ctx.fillRect(x, 0, (phrase ? 2.5 : bar ? 2 : 1) * dpr, h);
          if (bar && pxPerBeat * 4 >= 34) {
            ctx.fillStyle = phrase ? "rgba(255,210,80,0.95)" : "rgba(255,255,255,0.45)";
            ctx.font = `${9 * dpr}px ui-monospace, monospace`;
            ctx.fillText(String(Math.floor(k / 4) + 1), x + 3 * dpr, h - 4 * dpr);
          }
        }
        k += step;
      }
    }

    // Waveform.
    if (samplesPerPx >= 256) {
      let lvl = pyramid.levels[0];
      for (const l of pyramid.levels) {
        if (l.bucket <= samplesPerPx) lvl = l;
        else break;
      }
      const B = lvl.bucket;
      for (let x = 0; x < w; x++) {
        const s0 = (left + x * secPerPx) * sr;
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
    } else {
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
      ctx.fillStyle = accent;
      for (let x = 0; x < w; x++) {
        const i0 = Math.max(0, Math.floor((left + x * secPerPx) * sr));
        const i1 = Math.min(ch0.length, Math.ceil((left + (x + 1) * secPerPx) * sr));
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

    // Markers.
    const flag = (t: number, color: string, label?: string) => {
      if (t < left || t > left + trackWindow) return;
      const x = toX(t);
      ctx.fillStyle = color;
      ctx.fillRect(x - dpr * 0.5, 0, dpr, h);
      ctx.fillRect(x, 0, 11 * dpr, 11 * dpr);
      if (label) {
        ctx.fillStyle = "#06080c";
        ctx.font = `bold ${8 * dpr}px ui-monospace, monospace`;
        ctx.fillText(label, x + 2 * dpr, 8.5 * dpr);
      }
    };
    if (loop && loop.end > loop.start) {
      flag(loop.start, "#6ee7a8", "▶");
      flag(loop.end, "#6ee7a8", "◀");
    }
    if (loopInPoint != null) flag(loopInPoint, "#6ee7a8");
    if (cuePoint != null) flag(cuePoint, "#ff8a3c", "C");
    hotCues.forEach((t, i) => {
      if (t != null) flag(t, CUE_COLORS[i % CUE_COLORS.length], String(i + 1));
    });

    // Center playhead.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
  }, [pyramid, buffer, position, rate, beatgrid, loop, cuePoint, hotCues, loopInPoint, trackWindow, accent, duration, sr]);

  return (
    <div className="wv-wrap">
      <canvas
        ref={canvasRef}
        className="waveform"
        style={{ touchAction: "none" }}
        onWheel={(e) => onZoom(clampWin(windowSec * (e.deltaY > 0 ? 1.25 : 0.8)))}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pinch.current.set(e.pointerId, e.clientX);
          if (pinch.current.size === 1) {
            drag.current = { x: e.clientX };
            scrubbing.current = true;
            onScrubStart();
          } else if (pinch.current.size === 2) {
            endScrub(); // a second finger = pinch-zoom, not scrub
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
            if (pinchDist.current > 0) onZoom(clampWin(windowSec * (pinchDist.current / d)));
            pinchDist.current = d;
            return;
          }
          if (!drag.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const dxPx = e.clientX - drag.current.x;
          drag.current.x = e.clientX;
          onScrub((-dxPx / rect.width) * trackWindow);
        }}
        onPointerUp={(e) => {
          pinch.current.delete(e.pointerId);
          if (pinch.current.size < 2) pinchDist.current = 0;
          if (pinch.current.size === 0) {
            drag.current = null;
            endScrub();
          }
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          pinch.current.clear();
          pinchDist.current = 0;
          endScrub();
        }}
      />
      <div className="wv-zoom">
        <button onClick={() => onZoom(clampWin(windowSec * 0.6))}>+</button>
        <button onClick={() => onZoom(clampWin(windowSec * 1.6))}>−</button>
      </div>
    </div>
  );
}

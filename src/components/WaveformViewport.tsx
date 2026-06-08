import { useEffect, useRef, useState } from "react";
import type { Beatgrid, Pyramid } from "../audio/analyze";

interface WaveformViewportProps {
  pyramid: Pyramid | null;
  buffer: AudioBuffer | null;
  position: number; // playhead seconds (pinned at center)
  duration: number;
  beatgrid: Beatgrid | null;
  loop: { start: number; end: number } | null;
  accent: string;
  onScrub: (deltaSeconds: number) => void; // drag to nudge/align
}

// Single continuously-zoomable waveform. The playhead is pinned at center and
// the track scrolls past it. Zoom (wheel / pinch / ± buttons) ranges from the
// whole track down to a handful of samples — picking the right LOD pyramid level
// per frame, or reading the raw buffer when zoomed past the finest level. Beat
// grid lines (downbeats brighter) let you line deck A and B up beat-for-beat.
export function WaveformViewport({
  pyramid,
  buffer,
  position,
  duration,
  beatgrid,
  loop,
  accent,
  onScrub,
}: WaveformViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [windowSec, setWindowSec] = useState(8);
  const drag = useRef<{ x: number } | null>(null);
  const pinch = useRef<Map<number, number>>(new Map());
  const pinchDist = useRef(0);

  const sr = pyramid?.sampleRate ?? 44100;
  const minWin = 64 / sr;
  const maxWin = Math.max(1, duration || 1);
  const clampWin = (w: number) => Math.max(minWin, Math.min(maxWin, w));

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
    const left = position - windowSec / 2;
    const secPerPx = windowSec / w;
    const samplesPerPx = secPerPx * sr;

    // Loop region (behind everything).
    if (loop && loop.end > loop.start) {
      const lx = ((loop.start - left) / windowSec) * w;
      const lw = ((loop.end - loop.start) / windowSec) * w;
      ctx.fillStyle = "rgba(110,231,168,0.14)";
      ctx.fillRect(lx, 0, lw, h);
    }

    // Beat grid.
    if (beatgrid) {
      const { firstBeat, interval } = beatgrid;
      let k = Math.ceil((left - firstBeat) / interval);
      for (;;) {
        const t = firstBeat + k * interval;
        if (t > left + windowSec) break;
        if (t >= 0 && t <= duration) {
          const x = ((t - left) / windowSec) * w;
          const downbeat = ((k % 4) + 4) % 4 === 0;
          ctx.fillStyle = downbeat ? "rgba(255,210,80,0.5)" : "rgba(255,255,255,0.12)";
          ctx.fillRect(x, 0, (downbeat ? 2 : 1) * dpr, h);
        }
        k++;
      }
    }

    if (samplesPerPx >= 256) {
      // Use the pyramid: pick the finest level whose bucket ≤ samplesPerPx.
      let lvl = pyramid.levels[0];
      for (const l of pyramid.levels) {
        if (l.bucket <= samplesPerPx) lvl = l;
        else break;
      }
      const B = lvl.bucket;
      for (let x = 0; x < w; x++) {
        const s0 = (left + x * secPerPx) * sr;
        const s1 = s0 + samplesPerPx;
        let b0 = Math.floor(s0 / B);
        let b1 = Math.floor(s1 / B);
        if (b1 < 0 || b0 >= lvl.min.length) continue;
        b0 = Math.max(0, b0);
        b1 = Math.min(lvl.min.length - 1, b1);
        let lo = 1;
        let hi = -1;
        let lsum = 0;
        let msum = 0;
        let hsum = 0;
        let c = 0;
        for (let b = b0; b <= b1; b++) {
          if (lvl.min[b] < lo) lo = lvl.min[b];
          if (lvl.max[b] > hi) hi = lvl.max[b];
          lsum += lvl.low[b];
          msum += lvl.mid[b];
          hsum += lvl.high[b];
          c++;
        }
        if (c === 0) continue;
        const L = lsum / c;
        const M = msum / c;
        const H = hsum / c;
        const sum = L + M + H + 1e-6;
        const r = (L * 40 + M * 245 + H * 220) / sum;
        const g = (L * 105 + M * 155 + H * 238) / sum;
        const bl = (L * 235 + M * 45 + H * 255) / sum;
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
    } else {
      // Zoomed past the pyramid — read the raw buffer (window is tiny, cheap).
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

    // Center playhead.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
  }, [pyramid, buffer, position, beatgrid, loop, windowSec, accent, duration, sr]);

  return (
    <div className="wv-wrap">
      <canvas
        ref={canvasRef}
        className="waveform"
        style={{ touchAction: "none" }}
        onWheel={(e) => {
          setWindowSec((wsec) => clampWin(wsec * (e.deltaY > 0 ? 1.25 : 0.8)));
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pinch.current.set(e.pointerId, e.clientX);
          if (pinch.current.size === 1) drag.current = { x: e.clientX };
          else if (pinch.current.size === 2) {
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
            if (pinchDist.current > 0) {
              const ratio = pinchDist.current / d;
              setWindowSec((wsec) => clampWin(wsec * ratio));
            }
            pinchDist.current = d;
            return;
          }
          if (!drag.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const dxPx = e.clientX - drag.current.x;
          drag.current.x = e.clientX;
          onScrub((-dxPx / rect.width) * windowSec); // drag right = scroll back (like vinyl)
        }}
        onPointerUp={(e) => {
          pinch.current.delete(e.pointerId);
          if (pinch.current.size < 2) pinchDist.current = 0;
          if (pinch.current.size === 0) drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <div className="wv-zoom">
        <button onClick={() => setWindowSec((w) => clampWin(w * 0.6))}>+</button>
        <button onClick={() => setWindowSec((w) => clampWin(w * 1.6))}>−</button>
      </div>
    </div>
  );
}

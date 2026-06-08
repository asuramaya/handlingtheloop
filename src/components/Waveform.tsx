import { useEffect, useRef } from "react";
import type { Peak } from "../audio/analyze";

interface WaveformProps {
  peaks: Peak[] | null;
  /** playhead position as a fraction [0, 1] of the track. */
  progress: number;
  onSeek: (fraction: number) => void;
  accent: string;
}

// Canvas overview waveform. Played portion is drawn in the deck accent color,
// the rest dimmed; a playhead line marks the current position. Click to seek.
export function Waveform({ peaks, progress, onSeek, accent }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c0d12";
    ctx.fillRect(0, 0, w, h);

    if (!peaks || peaks.length === 0) {
      ctx.fillStyle = "#3a3d4a";
      ctx.font = `${12 * dpr}px ui-monospace, monospace`;
      ctx.fillText("no track loaded", 12 * dpr, h / 2);
      return;
    }

    const mid = h / 2;
    const playedX = progress * w;
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const p = peaks[i];
      const top = mid - p.max * mid;
      const bottom = mid - p.min * mid;
      ctx.fillStyle = x <= playedX ? accent : "#2b2e3a";
      ctx.fillRect(x, top, Math.max(1, w / peaks.length), Math.max(1, bottom - top));
    }

    // playhead
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(playedX - dpr, 0, 2 * dpr, h);
  }, [peaks, progress, accent]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - rect.left) / rect.width);
      }}
    />
  );
}

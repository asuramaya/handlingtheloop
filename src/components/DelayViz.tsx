import { useEffect, useRef } from "react";

// Echo-tap timeline for the Delay device — a predictive view of the repeats (NOT a live
// scope): the dry hit at t=0, then taps at each delay-time interval whose height decays by
// the feedback amount. Ping-Pong splits the taps L (above the centre) / R (below); Mono
// draws them symmetric. Freeze holds every tap at full height (no decay). A beat grid (from
// the deck BPM) underlays it so the echo's rhythmic subdivision reads at a glance. Imperative
// canvas (like the EQ curve) — redraws only when a param changes (cheap, not animated).

interface DelayVizProps {
  time: number; // seconds between taps
  feedback: number; // 0..1 decay per tap
  mix: number; // 0..1 — overall wet, dims the taps
  pingpong: boolean;
  frozen: boolean;
  bpm: number | null;
  accent: string;
}

export function DelayViz({ time, feedback, mix, pingpong, frozen, bpm, accent }: DelayVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const t = Math.max(0.001, time);
      const beat = bpm ? 60 / bpm : 0;
      // Window: a bar if we know the tempo, else 2 s — but always wide enough for ~5 taps.
      const windowSec = Math.max(beat > 0 ? beat * 4 : 2, t * 4.5, 0.4);
      const xOf = (s: number) => (s / windowSec) * w;
      const midY = h / 2;
      const maxBar = h * 0.42;

      // beat grid
      if (beat > 0) {
        ctx.lineWidth = 1;
        for (let s = beat, k = 1; s < windowSec; s += beat, k++) {
          ctx.strokeStyle = k % 4 === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
          const x = Math.round(xOf(s)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
      // centre line
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY + 0.5);
      ctx.lineTo(w, midY + 0.5);
      ctx.stroke();

      const barW = 3;
      const drawBar = (x: number, amp: number, where: "up" | "down" | "both", color: string, alpha: number) => {
        const bh = Math.max(1, maxBar * amp);
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        const round = (n: number) => Math.round(n);
        if (where === "up" || where === "both") ctx.fillRect(round(x - barW / 2), round(midY - bh), barW, round(bh));
        if (where === "down" || where === "both") ctx.fillRect(round(x - barW / 2), round(midY), barW, round(bh));
        ctx.globalAlpha = 1;
      };

      // dry hit at t=0 — white, full height, both sides
      drawBar(xOf(0) + barW / 2, 1, "both", "#ffffff", 0.85);

      // echoes: tap n at (n+1)·time, height feedback^n (or 1 if frozen)
      const wet = 0.35 + 0.65 * Math.max(0, Math.min(1, mix)); // dim low-mix delays a little
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        const amp = frozen ? 1 : Math.pow(Math.max(0, Math.min(0.999, feedback)), n);
        if (!frozen && amp < 0.02) break;
        const where = pingpong ? (n % 2 === 0 ? "up" : "down") : "both";
        drawBar(xOf(ts), amp, where, accent, 0.55 + 0.45 * amp * wet);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [time, feedback, mix, pingpong, frozen, bpm, accent]);

  return (
    <div className="dly-viz" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

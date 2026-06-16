import { useEffect, useRef } from "react";

// Echo-tap timeline for the Delay device — a predictive view of the repeats (NOT a live
// scope): the dry hit at t=0, then taps at each delay-time interval whose height decays by
// the feedback amount. Ping-Pong splits the taps L (above the centre) / R (below); Mono
// draws them symmetric. Freeze holds every tap at full height (no decay). A beat grid (from
// the deck BPM) underlays it so the echo's rhythmic subdivision reads at a glance. Imperative
// canvas (like the EQ curve) — redraws only when a param changes (cheap, not animated).
//
// The otherwise-invisible character params are layered on the SAME canvas as light overlays:
//   • HP/LP  → a filter ribbon along the top (the echoes' tone window, log-freq).
//   • DEPTH/RATE → each tap gets a wobble ghost (range ∝ depth) and is nudged by sin(rate·t).
//   • DUCK   → a sidechain dip pulls the early taps down, recovering over ~½ beat.
//   • WIDTH  → taps split L(up)/R(down) by a small horizontal offset (stereo time-spread).
//   • DRIVE  → a warm glow on the taps that grows with saturation.

interface DelayVizProps {
  time: number; // seconds between taps
  feedback: number; // 0..1 decay per tap
  mix: number; // 0..1 — overall wet, dims the taps
  pingpong: boolean;
  frozen: boolean;
  bpm: number | null;
  accent: string;
  hp: number; // feedback band-pass low-cut (Hz)
  lp: number; // feedback band-pass high-cut (Hz)
  modDepth: number; // LFO → delay-time depth (0..0.012 s)
  modRate: number; // LFO rate (Hz)
  drive: number; // analog saturation (0..1)
  duck: number; // sidechain ducking (0..1)
  width: number; // stereo L/R time spread (0..1)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const MOD_MAX = 0.012; // matches DELAY modDepth cell max — normalises depth to 0..1

export function DelayViz({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width }: DelayVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    // Resize only when the box actually changes (re-allocating the canvas every animation
    // frame would clear + thrash). Returns the current CSS-pixel size.
    let lastW = 0;
    let lastH = 0;
    let lastDpr = 0;
    const sizeCanvas = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      if (w !== lastW || h !== lastH || dpr !== lastDpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        lastW = w;
        lastH = h;
        lastDpr = dpr;
      }
      return { w, h, dpr };
    };

    const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
    const start = window.performance.now();

    // THREE layers sharing one viewport: (1) the HP/LP band as a full-height backdrop,
    // (2) a live scrolling LFO for DEPTH/RATE, (3) the echo taps on top.
    const draw = (now: number) => {
      const { w, h, dpr } = sizeCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const round = (n: number) => Math.round(n);
      const t = Math.max(0.001, time);
      const beat = bpm ? 60 / bpm : 0;
      const windowSec = Math.max(beat > 0 ? beat * 4 : 2, t * 4.5, 0.4);
      const xOf = (s: number) => (s / windowSec) * w;
      const midY = h / 2;
      const maxBar = h * 0.42;
      const elapsed = (now - start) / 1000;

      // === LAYER 1 — HP/LP filter, a full-height bandpass HILL behind everything. The lit
      // region spans HP→LP on a log-freq scale (20 Hz‥20 kHz across the width); it flattens
      // to the full width when the cuts are parked open. A soft backdrop, not a panel. ===
      const fx = (f: number) => (Math.log(Math.max(20, Math.min(20000, f)) / 20) / Math.log(20000 / 20)) * w;
      const lo = fx(hp);
      const hi = fx(lp);
      const edge = Math.max(8, (hi - lo) * 0.25);
      const band = (x: number) => Math.max(0, Math.min(smooth((x - lo) / edge), smooth((hi - x) / edge)));
      const fTop = h * 0.06;
      const fBot = h * 0.94;
      const fyAt = (x: number) => fBot - band(x) * (fBot - fTop);
      ctx.beginPath();
      ctx.moveTo(0, fBot);
      for (let x = 0; x <= w; x += 2) ctx.lineTo(x, fyAt(x));
      ctx.lineTo(w, fBot);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.08;
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) (x === 0 ? ctx.moveTo(x, fyAt(x)) : ctx.lineTo(x, fyAt(x)));
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // beat grid + centre line
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
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY + 0.5);
      ctx.lineTo(w, midY + 0.5);
      ctx.stroke();

      // === LAYER 2 — DEPTH/RATE as a LIVE LFO: a sine that scrolls at the LFO rate, its
      // height set by depth and its wavelength by rate. Flat (invisible) at depth 0. ===
      const modN = clamp01(modDepth / MOD_MAX);
      const phase = 2 * Math.PI * modRate * elapsed; // advances in real time → it moves
      const lfoNow = modN * Math.sin(-phase); // instantaneous LFO value, drives the taps
      if (modN > 0.001 && modRate > 0) {
        const lfoAmp = modN * h * 0.22;
        const cycles = Math.max(0.5, modRate * windowSec); // LFO cycles across the viewport
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
          const y = midY + lfoAmp * Math.sin((2 * Math.PI * cycles * x) / w - phase);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      // === LAYER 3 — the echo taps ===
      const wet = 0.35 + 0.65 * clamp01(mix);
      const modShift = lfoNow * 8; // taps slide with the live LFO (DEPTH/RATE made felt)
      const widthOff = clamp01(width) * 7; // L/up · R/down spread (WIDTH)
      const duckTau = (beat > 0 ? beat : 0.5) * 0.5;
      const duckGain = (s: number) => 1 - clamp01(duck) * Math.exp(-s / duckTau); // DUCK pump
      const barW = 3;
      const tap = (x: number, amp: number, side: "up" | "down", alpha: number) => {
        const bh = Math.max(1, maxBar * amp);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = accent;
        if (side === "up") ctx.fillRect(round(x - barW / 2), round(midY - bh), barW, round(bh));
        else ctx.fillRect(round(x - barW / 2), round(midY), barW, round(bh));
        ctx.globalAlpha = 1;
      };

      // dry hit at t=0 — clean white source, inset 1px so it isn't clipped at the edge.
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(1, round(midY - maxBar), barW, round(maxBar * 2));
      ctx.globalAlpha = 1;

      // DRIVE → warm glow behind the echoes (saturation made visible).
      ctx.shadowColor = "rgba(255,170,90,0.9)";
      ctx.shadowBlur = clamp01(drive) * 8;
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        const base = frozen ? 1 : Math.pow(Math.max(0, Math.min(0.999, feedback)), n);
        if (!frozen && base < 0.02) break;
        const amp = base * duckGain(ts);
        const where = pingpong ? (n % 2 === 0 ? "up" : "down") : "both";
        const x = xOf(ts) + modShift;
        const a = 0.55 + 0.45 * amp * wet;
        if (where === "up" || where === "both") tap(x - (where === "both" ? widthOff : 0), amp, "up", a);
        if (where === "down" || where === "both") tap(x + (where === "both" ? widthOff : 0), amp, "down", a);
      }
      ctx.shadowBlur = 0;
    };

    // Animate only while the LFO is active (otherwise a single static draw — no idle rAF).
    const animated = clamp01(modDepth / MOD_MAX) > 0.001 && modRate > 0;
    let raf = 0;
    if (animated) {
      const loop = (now: number) => {
        draw(now);
        raf = window.requestAnimationFrame(loop);
      };
      raf = window.requestAnimationFrame(loop);
    } else {
      draw(start);
    }
    const ro = new ResizeObserver(() => draw(window.performance.now()));
    ro.observe(wrap);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width]);

  return (
    <div className="dly-viz" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

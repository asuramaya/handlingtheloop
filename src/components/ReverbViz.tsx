import { useEffect, useRef } from "react";

// Reverb tail view — a full RADIAL display with a Pro-R-style decay-rate curve as its rim.
// Distinct from the delay's linear echo timeline on purpose: reverb is a space, not a
// sequence of events. Read it from the centre out:
//   • CENTRE = the source (a warm DRIVE glow); a dark inner disc = the PREDELAY gap.
//   • RADIUS outward = time → the diffuse fog dissipates as the tail decays; DECAY sets how
//     far it reaches, SIZE the circle's footprint, FREEZE halts it, MIX its presence.
//   • ANGLE around the circle = FREQUENCY (top = low, clockwise through mid to high). The
//     rim CURVE's reach at each angle = how long that band rings: BRIGHTNESS pulls the high
//     side in, LO/HI CUT flatten the curve at the band edges, WIDTH lifts the mids.
//   • CHARACTER ripples the rim; DUCK makes the whole bloom breathe; DRIVE warms + swells the
//     core. (v2: drag the rim to set a band's decay.) Animates only when something moves.

interface ReverbVizProps {
  size: number; // 0..1 footprint
  decay: number; // 0..1 tail reach
  brightness: number; // 0..1 HF decay (1 = HF rings on)
  predelay: number; // seconds
  width: number; // 0..1.5 stereo spread
  lowCut: number; // Hz — tail low-cut
  highCut: number; // Hz — tail high-cut
  mix: number; // 0..1 wet → fog presence
  drive: number; // 0..1 input saturation → warm core
  duck: number; // 0..1 sidechain → the bloom breathes
  character: number; // 0..1 modulation depth
  modRate: number; // Hz
  frozen: boolean;
  accent: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const f2n = (hz: number) => clamp01(Math.log(clamp(hz, 20, 20000) / 20) / Math.log(1000)); // 20‥20k → 0..1 log
const TWO_PI = Math.PI * 2;
const WARM = "255,150,70"; // DRIVE glow colour

export function ReverbViz({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent }: ReverbVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

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
    const start = window.performance.now();
    const angOf = (fNorm: number) => -Math.PI / 2 + fNorm * TWO_PI; // top = low, clockwise

    const draw = (now: number) => {
      const { w, h, dpr } = sizeCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const sizeScale = 0.6 + clamp01(size) * 0.4;
      const R = Math.min(w, h) * 0.46 * sizeScale;
      const r0frac = 0.1 + clamp01(predelay / 0.2) * 0.22; // predelay gap (fraction of R)
      const r0 = R * r0frac;
      const span = R - r0;
      const elapsed = (now - start) / 1000;
      const phase = TWO_PI * modRate * elapsed;
      const reachBase = frozen ? 1 : 0.18 + clamp01(decay) * 0.82;
      const mixA = 0.32 + clamp01(mix) * 0.68;
      const dr = clamp01(drive);
      // DUCK — a pronounced slow breathe of the whole bloom (the sidechain pump).
      const duckPulse = duck > 0 ? 1 - clamp01(duck) * 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 2.4)) : 1;
      const loN = f2n(lowCut);
      const hiN = f2n(highCut);

      const reachAt = (fNorm: number) => {
        const tilt = 1 - (1 - clamp01(brightness)) * fNorm * 0.85;
        const band = smooth((fNorm - loN) / 0.06) * smooth((hiN - fNorm) / 0.06);
        const skew = 1 + (width - 1) * 0.16 * Math.sin(fNorm * Math.PI);
        const wob = character > 0 ? character * 0.05 * Math.sin(fNorm * 8 - phase) : 0;
        return clamp01(r0frac + reachBase * tilt * band * skew * (1 - r0frac) + wob) * duckPulse;
      };

      // === diffuse BLOOM — radial fog, warmed by DRIVE, scaled by MIX + DUCK breathe ===
      const fogR = R * reachBase * duckPulse;
      const grad = ctx.createRadialGradient(cx, cy, r0 * 0.6, cx, cy, Math.max(r0 + 1, fogR));
      grad.addColorStop(0, dr > 0 ? `rgba(${WARM},${(0.34 + dr * 0.3) * mixA})` : withAlpha(accent, 0.4 * mixA));
      grad.addColorStop(0.5, withAlpha(accent, 0.14 * mixA));
      grad.addColorStop(1, withAlpha(accent, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(r0 + 1, fogR), 0, TWO_PI);
      ctx.fill();

      // drifting energy rings (outward = time), breathing with DUCK.
      const RINGS = 4;
      for (let i = 0; i < RINGS; i++) {
        const u = (elapsed * 0.16 + i / RINGS) % 1;
        const rr = (r0 + u * (fogR - r0)) * 1;
        const a = (frozen ? 0.2 : 0.24 * (1 - u)) * (0.5 + 0.5 * clamp01(decay)) * mixA;
        ctx.strokeStyle = withAlpha(accent, a);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, rr), 0, TWO_PI);
        ctx.stroke();
      }

      // frequency guide spokes (low / mid / high).
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (const fN of [0, 0.33, 0.66]) {
        const a = angOf(fN);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      }

      // === decay-rate CURVE (Pro-R, polar) — radius per angle = that band's decay ===
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const fNorm = i / 120;
        const r = r0 + reachAt(fNorm) * span;
        const a = angOf(fNorm);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = withAlpha(accent, 0.1 * mixA);
      ctx.fill();
      ctx.strokeStyle = withAlpha(accent, 0.85);
      ctx.lineWidth = 1.5;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 5;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // SIZE → faint room boundary.
      ctx.strokeStyle = withAlpha(accent, 0.1 + clamp01(size) * 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TWO_PI);
      ctx.stroke();

      // predelay inner disc (dark gap before the onset).
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.arc(cx, cy, r0, 0, TWO_PI);
      ctx.fill();

      // === DRIVE → a warm, swelling core glow at the source (unmistakable when up) ===
      ctx.save();
      const coreR = Math.max(3, R * 0.14) * (1 + dr * 1.1) * duckPulse;
      if (dr > 0) {
        ctx.shadowColor = `rgba(${WARM},0.95)`;
        ctx.shadowBlur = 8 + dr * 26;
        ctx.fillStyle = `rgba(${WARM},${0.55 + dr * 0.4})`;
      } else {
        ctx.fillStyle = withAlpha(accent, 0.85);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TWO_PI);
      ctx.fill();
      ctx.restore();

      // labels
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.font = "8px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("LOW", cx, 9);
      ctx.textAlign = "left";
      if (frozen) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(elapsed * 3));
        ctx.fillText("❄ FROZEN", w - 56, 10);
        ctx.globalAlpha = 1;
      }
    };

    const animated = (character > 0 && modRate > 0) || frozen || duck > 0;
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
  }, [size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent]);

  return (
    <div className="rv-viz" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// accent is a resolved hex (#rrggbb / #rgb) or rgb()/rgba() string — wrap it with an alpha.
function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (c.length === 7) {
      r = parseInt(c.slice(1, 3), 16);
      g = parseInt(c.slice(3, 5), 16);
      b = parseInt(c.slice(5, 7), 16);
    } else if (c.length === 4) {
      r = parseInt(c[1] + c[1], 16);
      g = parseInt(c[2] + c[2], 16);
      b = parseInt(c[3] + c[3], 16);
    }
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(",").slice(0, 3).map((s) => s.trim());
    return `rgba(${parts.join(",")},${a})`;
  }
  return c;
}

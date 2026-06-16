import { useEffect, useRef } from "react";

// Reverb tail view — a full RADIAL display with a Pro-R-style decay-rate curve as its rim,
// AND a direct-control surface (like the EQ curve): the dome's grips ARE the knobs. Read it
// from the centre out:
//   • CENTRE = the source (a warm DRIVE glow); a dark inner disc = the PREDELAY gap.
//   • RADIUS outward = time → the diffuse fog dissipates as the tail decays; DECAY sets how
//     far it reaches, SIZE the circle's footprint, FREEZE halts it, MIX its presence.
//   • ANGLE around the circle = FREQUENCY (top = low, clockwise through mid to high). The
//     rim CURVE's reach at each angle = how long that band rings: BRIGHTNESS pulls the high
//     side in, LO/HI CUT flatten the curve at the band edges, WIDTH lifts the mids.
//   • CHARACTER ripples the rim; DUCK makes the whole bloom breathe; DRIVE warms + swells the
//     core. Animates only when something moves.
//
// DIRECT CONTROL (WYSIWYG, the EQ pattern): drag a grip to set its param.
//   rim LOW grip  → DECAY   (shift-wheel → CHARACTER)
//   rim MID grip  → WIDTH   (shift-wheel → RATE)
//   rim HIGH grip → BRIGHT
//   disc edge     → PREDLY     boundary ring → SIZE     core → DRIVE
//   LO/HI band-edge grips (drag AROUND the rim) → LO CUT / HI CUT
//   wheel over a grip nudges it; dbl-click / right-click resets it. MIX·DUCK stay as cells.

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
  onParam: (param: string, value: number) => void; // direct-control callback (drag/wheel)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const f2n = (hz: number) => clamp01(Math.log(clamp(hz, 20, 20000) / 20) / Math.log(1000)); // 20‥20k → 0..1 log
const n2f = (n: number) => 20 * Math.pow(1000, clamp01(n)); // inverse of f2n
const TWO_PI = Math.PI * 2;
const WARM = "255,150,70"; // DRIVE glow colour

// Pixels of radial drag that span a grip's whole range (matches ValueCell's feel).
const DRAG_SPAN_PX = 130;
const GRAB_PX = 16; // pointer-to-grip hit radius

// A grip's static meta. Radial grips map drag DISTANCE-from-centre → param; angular grips
// (the band-edge cuts) map drag ANGLE-around-the-rim → param. Some carry a shift-wheel
// secondary, exactly like the EQ node's shift-wheel = Q.
interface Grip {
  id: string;
  param: string;
  label: string;
  kind: "radial" | "angular";
  min: number;
  max: number;
  def: number;
  fmt: (v: number) => string;
  sec?: { param: string; min: number; max: number };
}
const pct = (v: number) => `${Math.round(v * 100)}`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const ms = (v: number) => `${Math.round(v * 1000)}ms`;
const GRIPS: Grip[] = [
  { id: "decay", param: "decay", label: "DECAY", kind: "radial", min: 0, max: 1, def: 0.5, fmt: pct, sec: { param: "character", min: 0, max: 1 } },
  { id: "width", param: "width", label: "WIDTH", kind: "radial", min: 0, max: 1.5, def: 1, fmt: pct, sec: { param: "modRate", min: 0.02, max: 6 } },
  { id: "bright", param: "brightness", label: "BRIGHT", kind: "radial", min: 0, max: 1, def: 0.6, fmt: pct },
  { id: "predelay", param: "predelay", label: "PREDLY", kind: "radial", min: 0, max: 0.2, def: 0.012, fmt: ms },
  { id: "size", param: "size", label: "SIZE", kind: "radial", min: 0, max: 1, def: 0.6, fmt: pct },
  { id: "drive", param: "drive", label: "DRIVE", kind: "radial", min: 0, max: 1, def: 0, fmt: pct },
  { id: "lowCut", param: "lowCut", label: "LO CUT", kind: "angular", min: 20, max: 2000, def: 20, fmt: hz },
  { id: "highCut", param: "highCut", label: "HI CUT", kind: "angular", min: 1000, max: 20000, def: 18000, fmt: hz },
];

interface Placed extends Grip {
  x: number;
  y: number;
}

export function ReverbViz({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent, onParam }: ReverbVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Live state the pointer/wheel handlers read (kept off the effect's closure so the listeners
  // can be attached once yet always see fresh values).
  const params = useRef({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate });
  params.current = { size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate };
  const onParamRef = useRef(onParam);
  onParamRef.current = onParam;
  const center = useRef({ cx: 0, cy: 0 }); // canvas centre, for radius/angle of a pointer
  const placed = useRef<Placed[]>([]); // grips at their current screen positions (hit-testing)
  const hover = useRef<string | null>(null);
  const drag = useRef<{ grip: Grip; startVal: number; startR: number; startAngN: number } | null>(null);
  const lastTap = useRef(0);
  const drawRef = useRef<(now: number) => void>(() => {});
  const nowRef = useRef(0);

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
      nowRef.current = now;
      const { w, h, dpr } = sizeCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      center.current = { cx, cy };
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

      // === place + draw the interactive GRIPS (the dome's "knobs") ===
      // Rim grips ride the curve at fixed band angles (kept inside the live cut window so they
      // never collapse onto the centre); disc/boundary/core grips sit at fixed visual angles;
      // the cut grips ride the rim at their own cutoff angle (drag them AROUND to sweep).
      const rimAng = (fNorm: number) => {
        const r = r0 + reachAt(fNorm) * span;
        const a = angOf(fNorm);
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
      };
      const at = (a: number, rad: number) => ({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
      const fLow = clamp(loN + 0.1, 0.06, 0.32);
      const fMid = clamp((loN + hiN) / 2, 0.34, 0.66);
      const fHigh = clamp(hiN - 0.1, 0.68, 0.94);
      const posFor = (id: string): { x: number; y: number } => {
        switch (id) {
          case "decay": return rimAng(fLow);
          case "width": return rimAng(fMid);
          case "bright": return rimAng(fHigh);
          case "predelay": return at(angOf(0.875), r0); // up-left, on the disc edge
          case "size": return at(angOf(0.125), R); // up-right, on the boundary ring
          case "drive": return at(Math.PI / 2, Math.max(coreR, R * 0.16)); // straight down, off the core
          case "lowCut": return at(angOf(loN), R * 0.92);
          case "highCut": return at(angOf(hiN), R * 0.92);
          default: return { x: cx, y: cy };
        }
      };
      placed.current = GRIPS.map((g) => ({ ...g, ...posFor(g.id) }));

      for (const g of placed.current) {
        const active = drag.current?.grip.id === g.id;
        const hot = active || hover.current === g.id;
        ctx.beginPath();
        ctx.arc(g.x, g.y, hot ? 6 : 4.5, 0, TWO_PI);
        ctx.fillStyle = hot ? "#fff" : withAlpha(accent, 0.92);
        ctx.shadowColor = accent;
        ctx.shadowBlur = hot ? 10 : 4;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = withAlpha(accent, hot ? 1 : 0.5);
        ctx.stroke();
      }

      // active grip readout — its label + value, top-left (mirrors the EQ band-edit chip).
      const act = drag.current;
      if (act) {
        const v = (params.current as Record<string, number>)[act.grip.param];
        ctx.fillStyle = accent;
        ctx.font = "700 9px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`${act.grip.label} ${act.grip.fmt(v)}`, 6, 11);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.font = "8px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("LOW", cx, 9);
        ctx.textAlign = "left";
      }
      if (frozen) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(elapsed * 3));
        ctx.fillText("❄ FROZEN", w - 56, 10);
        ctx.globalAlpha = 1;
      }
    };
    drawRef.current = draw;

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
    const ro = new ResizeObserver(() => draw(nowRef.current || start));
    ro.observe(wrap);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent]);

  // --- direct control: hit-test grips, map drag → param (no audio nodes; just onParam) ---
  const localPt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const angN = (x: number, y: number) => {
    const { cx, cy } = center.current;
    return (Math.atan2(y - cy, x - cx) / TWO_PI + 1.25) % 1; // 0 at top, clockwise (matches fNorm)
  };
  const radOf = (x: number, y: number) => {
    const { cx, cy } = center.current;
    return Math.hypot(x - cx, y - cy);
  };
  const nearest = (x: number, y: number): Grip | null => {
    let best: Grip | null = null;
    let bestD = GRAB_PX;
    for (const g of placed.current) {
      const d = Math.hypot(x - g.x, y - g.y);
      if (d <= bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  };
  const redraw = () => drawRef.current(nowRef.current || window.performance.now());

  // Native, non-passive wheel — nudge the hovered grip (shift = its secondary), like ValueCell.
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const pt = localPt(e);
      const g = nearest(pt.x, pt.y) ?? (hover.current ? placed.current.find((p) => p.id === hover.current) ?? null : null);
      if (!g) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const tgt = e.shiftKey && g.sec ? g.sec : { param: g.param, min: g.min, max: g.max };
      const cur = (params.current as Record<string, number>)[tgt.param];
      const unit = (tgt.max - tgt.min) / 40;
      onParamRef.current(tgt.param, clamp(cur + dir * unit, tgt.min, tgt.max));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className="rv-viz"
      ref={wrapRef}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // right-button resets via onContextMenu
        const pt = localPt(e);
        const g = nearest(pt.x, pt.y);
        if (!g) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        // Double-tap a grip resets it to its default.
        if (e.timeStamp - lastTap.current < 320 && hover.current === g.id) {
          onParam(g.param, g.def);
          lastTap.current = 0;
          drag.current = null;
          redraw();
          return;
        }
        lastTap.current = e.timeStamp;
        const startVal = (params.current as Record<string, number>)[g.param];
        drag.current = { grip: g, startVal, startR: radOf(pt.x, pt.y), startAngN: angN(pt.x, pt.y) };
        hover.current = g.id;
        redraw();
      }}
      onPointerMove={(e) => {
        const pt = localPt(e);
        const d = drag.current;
        if (d) {
          const g = d.grip;
          if (g.kind === "radial") {
            const delta = radOf(pt.x, pt.y) - d.startR; // outward = increase
            onParam(g.param, clamp(d.startVal + (delta / DRAG_SPAN_PX) * (g.max - g.min), g.min, g.max));
          } else {
            let dN = angN(pt.x, pt.y) - d.startAngN; // clockwise = up
            dN = ((dN + 0.5) % 1 + 1) % 1 - 0.5; // shortest signed wrap
            onParam(g.param, clamp(n2f(f2n(d.startVal) + dN), g.min, g.max));
          }
          return;
        }
        // hover highlight
        const g = nearest(pt.x, pt.y);
        const id = g?.id ?? null;
        if (id !== hover.current) {
          hover.current = id;
          redraw();
        }
      }}
      onPointerUp={(e) => {
        if (drag.current) {
          drag.current = null;
          redraw();
        }
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onContextMenu={(e) => {
        const pt = localPt(e);
        const g = nearest(pt.x, pt.y);
        if (g) {
          e.preventDefault();
          onParam(g.param, g.def);
          redraw();
        }
      }}
    >
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

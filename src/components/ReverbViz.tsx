import { useEffect, useRef } from "react";
import { dragBand, dragHp, dragLp, drawFreqRibbon, fmtHz, hitFreqRibbon, type RibbonHot, type RibbonRange } from "./FreqRibbon";
import { dragRail, drawRail, hitRail, type RailRect } from "./ValueRail";

// Reverb's control surface — same structural idiom as the delay now, not a circle: a READOUT
// strip, a tone RIBBON right under it (the SAME primitive the delay's tap timeline uses), then a
// row of value RAILS (the SAME primitive the delay's DRIVE/DUCK gutters use). Two shared pieces,
// not two hand-derived copies, and nothing radial anywhere — a control surface built from the
// same effect-lets as the rest of the rack reads as PART of the rack, not a different instrument
// wearing its skin.
//   • READOUT (top)  → LEFT: DECAY · SIZE, always on. CENTER: whatever you're touching, blank
//     otherwise. RIGHT: the ribbon's Hz range, or ❄ FROZEN.
//   • RIBBON (top, under the readout) → the tail's tone window, log-Hz, drag an edge to move one
//     cut, drag the body to sweep both.
//   • RAIL ROW (fills the rest) → PREDLY · WIDTH · SIZE · DECAY · DUCK · DRIVE · BRIGHT, one
//     column each: a thin always-visible track + a puck riding it, BOTTOM 0 → TOP 100, absolute.
//     shift-wheel on DECAY → CHAR, on WIDTH → RATE. wheel nudges; dbl-click / right-click resets.

interface ReverbVizProps {
  size: number; // 0..1 footprint
  decay: number; // 0..1 tail reach
  brightness: number; // 0..1 HF decay (1 = HF rings on)
  predelay: number; // seconds
  width: number; // 0..1.5 stereo spread
  lowCut: number; // Hz — tail low-cut
  highCut: number; // Hz — tail high-cut
  mix: number; // 0..1 wet presence (unused here — lives in the universal wet/dry fader)
  drive: number; // 0..1 input saturation
  duck: number; // 0..1 sidechain depth
  character: number; // 0..1 modulation depth
  modRate: number; // Hz
  frozen: boolean;
  accent: string;
  onParam: (param: string, value: number) => void; // direct-control callback (drag/wheel)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const READOUT_H = 13; // the one readout strip, across the top — same contract as the delay's
const NARROW_PX = 260; // below this the deck is a phone column, not a desktop panel
const RIBBON_GRIP_PX = 10; // how close counts as "on" a ribbon edge (delay's GRIP_PX)
const LABEL_H = 11; // reserved strip under the rails for each one's permanent short label
const RAIL_W = 3;
const PUCK_W = 11;

// ReverbFx's own real DSP bounds (ReverbFx.ts) — asymmetric, not one shared range like the
// delay's cuts. Passing anything looser would let this ribbon's grip drift somewhere the DSP
// silently clamps back from underneath it.
const RIBBON_RANGE: RibbonRange = { loMin: 20, loMax: 2000, hiMin: 1000, hiMax: 20000, minRatio: 1.1 };

interface Grip {
  id: string;
  param: string;
  label: string;
  min: number;
  max: number;
  def: number;
  fmt: (v: number) => string;
  sec?: { param: string; min: number; max: number }; // shift-wheel secondary
}
const pct = (v: number) => `${Math.round(v * 100)}`;
const ms = (v: number) => `${Math.round(v * 1000)}ms`;
const GRIPS: Grip[] = [
  { id: "predelay", param: "predelay", label: "PREDLY", min: 0, max: 0.2, def: 0.012, fmt: ms },
  { id: "width", param: "width", label: "WIDTH", min: 0, max: 1.5, def: 1, fmt: pct, sec: { param: "modRate", min: 0.02, max: 6 } },
  { id: "size", param: "size", label: "SIZE", min: 0, max: 1, def: 0.6, fmt: pct },
  { id: "decay", param: "decay", label: "DECAY", min: 0, max: 1, def: 0.5, fmt: pct, sec: { param: "character", min: 0, max: 1 } },
  { id: "duck", param: "duck", label: "DUCK", min: 0, max: 1, def: 0, fmt: pct },
  { id: "drive", param: "drive", label: "DRIVE", min: 0, max: 1, def: 0, fmt: pct },
  { id: "bright", param: "brightness", label: "BRIGHT", min: 0, max: 1, def: 0.6, fmt: pct },
];
const gripNorm = (g: Grip, v: number) => clamp01((v - g.min) / (g.max - g.min));
const gripVal = (g: Grip, n: number) => g.min + clamp01(n) * (g.max - g.min);

interface Ctx {
  w: number;
  h: number;
  ribbonY: number;
  ribbonH: number;
  railTop: number;
  railBot: number;
  colW: number;
}

type Drag = { kind: "grip"; grip: Grip } | { kind: "ribbon"; which: Exclude<RibbonHot, null>; lastX: number };

export function ReverbViz({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent, onParam }: ReverbVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const params = useRef({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate });
  params.current = { size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate };
  const onParamRef = useRef(onParam);
  onParamRef.current = onParam;
  const ctxRef = useRef<Ctx>({ w: 1, h: 1, ribbonY: 0, ribbonH: 1, railTop: 0, railBot: 1, colW: 1 });
  const hover = useRef<string | null>(null); // a grip id, or "hp"/"lp"/"band"
  const drag = useRef<Drag | null>(null);
  const lastTap = useRef(0);
  const drawRef = useRef<() => void>(() => {});

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

    // Geometry, shared by the renderer and the hit-tests. Top to bottom: the READOUT strip, the
    // tone RIBBON, then the rail row (which reserves its own floor for the per-rail labels).
    const geom = (w: number, h: number): Ctx => {
      const narrow = w < NARROW_PX;
      const ribbonH = narrow ? Math.max(26, Math.round(h * 0.22)) : Math.max(20, Math.round(h * 0.2));
      const ribbonY = READOUT_H;
      const railTop = ribbonY + ribbonH + 3;
      const railBot = h - LABEL_H - 2;
      const colW = w / GRIPS.length;
      return { w, h, ribbonY, ribbonH, railTop, railBot, colW };
    };

    const draw = () => {
      const { w, h, dpr } = sizeCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const c = geom(w, h);
      ctxRef.current = c;
      const p = params.current;

      const held = drag.current ? (drag.current.kind === "grip" ? drag.current.grip.id : drag.current.which) : null;
      const hot = held ?? hover.current;
      const hotGrip = hot ? GRIPS.find((g) => g.id === hot) ?? null : null;
      const hotRibbon: RibbonHot = hot === "hp" || hot === "lp" || hot === "band" ? hot : null;

      // === THE FILTER RIBBON — shared with the delay's tap timeline (FreqRibbon.ts). ===
      drawFreqRibbon(ctx, { x: 0, y: c.ribbonY, w, h: c.ribbonH - 4 }, p.lowCut, p.highCut, accent, hotRibbon);

      // === THE RAIL ROW — shared with the delay's DRIVE/DUCK gutters (ValueRail.ts). Each rail's
      //     permanent short label sits in the reserved floor strip below it — naming was hover-only
      //     on the old dome, which is exactly why the dots read as unlabeled at a glance. ===
      GRIPS.forEach((g, i) => {
        const isHot = hot === g.id;
        const colX = i * c.colW;
        const rect: RailRect = { x: colX, y: c.railTop, w: c.colW, h: c.railBot - c.railTop };
        drawRail(ctx, rect, gripNorm(g, (p as Record<string, number>)[g.param]), accent, isHot, RAIL_W, PUCK_W);
        ctx.font = isHot ? "700 9px system-ui, sans-serif" : "600 8px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isHot ? "#fff" : withAlpha(accent, 0.65);
        ctx.fillText(g.label, colX + c.colW / 2, c.railBot + 1);
      });

      // === THE READOUT — same 3-zone contract as the delay: LEFT = what the reverb IS, MIDDLE =
      //     what you're TOUCHING (blank when you aren't), RIGHT = its tone (or FROZEN). ===
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, w, READOUT_H - 1);
      const ry = (READOUT_H - 1) / 2;
      ctx.font = "800 9px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = accent;
      ctx.textAlign = "left";
      ctx.globalAlpha = 0.9;
      ctx.fillText(`${Math.round(clamp01(p.decay) * 100)}%  ·  ${Math.round(clamp01(p.size) * 100)}%`, 5, ry);
      ctx.textAlign = "right";
      if (frozen) {
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(window.performance.now() / 333));
        ctx.fillText("❄ FROZEN", w - 5, ry);
      } else {
        ctx.globalAlpha = 0.55;
        ctx.fillText(`${fmtHz(p.lowCut)} – ${fmtHz(p.highCut)}`, w - 5, ry);
      }
      ctx.globalAlpha = 1;
      const ctxLabel = hotGrip ? `${hotGrip.label} ${hotGrip.fmt((p as Record<string, number>)[hotGrip.param])}` : hotRibbon ? `${fmtHz(p.lowCut)} Hz – ${fmtHz(p.highCut)} Hz` : "";
      if (ctxLabel) {
        ctx.textAlign = "center";
        ctx.globalAlpha = 1;
        ctx.fillStyle = drag.current ? "#fff" : accent;
        ctx.fillText(ctxLabel, w / 2, ry);
      }
      ctx.globalAlpha = 1;
    };
    drawRef.current = draw;

    // FROZEN's pulse is the only thing that ever needs to redraw without a param changing —
    // everything else here is state, painted on demand (a drag, a hover change).
    let raf = 0;
    const loop = () => {
      draw();
      raf = frozen ? window.requestAnimationFrame(loop) : 0;
    };
    raf = window.requestAnimationFrame(loop);
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent]);

  // --- direct control: hit-test the ribbon + rail columns, map drag → param --------------------
  const localPt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const inRibbon = (y: number) => {
    const c = ctxRef.current;
    return y >= c.ribbonY && y <= c.ribbonY + c.ribbonH;
  };
  const gripAt = (x: number, y: number): Grip | null => {
    const c = ctxRef.current;
    if (y < c.railTop || y > c.railBot) return null;
    const i = clamp(Math.floor(x / c.colW), 0, GRIPS.length - 1);
    const rect: RailRect = { x: i * c.colW, y: c.railTop, w: c.colW, h: c.railBot - c.railTop };
    return hitRail(x, y, rect) ? GRIPS[i] : null;
  };
  const redraw = () => drawRef.current();

  // Native, non-passive wheel — nudge the hovered grip (shift = its secondary), like ValueCell.
  // Ribbon edges don't get wheel-nudge, matching the delay's own ribbon (no wheel there either).
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const pt = localPt(e);
      if (inRibbon(pt.y)) return;
      const g = gripAt(pt.x, pt.y) ?? (hover.current ? GRIPS.find((p) => p.id === hover.current) ?? null : null);
      if (!g) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const tgt = e.shiftKey && g.sec ? g.sec : { param: g.param, min: g.min, max: g.max };
      const cur = (params.current as Record<string, number>)[tgt.param];
      onParamRef.current(tgt.param, clamp(cur + (dir * (tgt.max - tgt.min)) / 40, tgt.min, tgt.max));
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
        if (inRibbon(pt.y)) {
          const c = ctxRef.current;
          const grip = c.w < NARROW_PX ? RIBBON_GRIP_PX * 1.6 : RIBBON_GRIP_PX;
          const kind = hitFreqRibbon(pt.x, pt.y, { x: 0, y: c.ribbonY, w: c.w, h: c.ribbonH }, params.current.lowCut, params.current.highCut, grip);
          if (kind) {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { kind: "ribbon", which: kind, lastX: pt.x };
            hover.current = kind;
            redraw();
          }
          return;
        }
        const g = gripAt(pt.x, pt.y);
        if (!g) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        // Double-tap a rail resets it to its default.
        if (e.timeStamp - lastTap.current < 320 && hover.current === g.id) {
          onParam(g.param, g.def);
          lastTap.current = 0;
          drag.current = null;
          redraw();
          return;
        }
        lastTap.current = e.timeStamp;
        drag.current = { kind: "grip", grip: g };
        hover.current = g.id;
        redraw();
      }}
      onPointerMove={(e) => {
        const pt = localPt(e);
        const d = drag.current;
        if (d) {
          const c = ctxRef.current;
          if (d.kind === "ribbon") {
            const rect = { x: 0, y: c.ribbonY, w: c.w, h: c.ribbonH };
            const lo = params.current.lowCut;
            const hi = params.current.highCut;
            if (d.which === "hp") onParamRef.current("lowCut", dragHp(pt.x, rect, hi, RIBBON_RANGE));
            else if (d.which === "lp") onParamRef.current("highCut", dragLp(pt.x, rect, lo, RIBBON_RANGE));
            else {
              const [nLo, nHi] = dragBand(pt.x - d.lastX, rect, lo, hi, RIBBON_RANGE);
              d.lastX = pt.x;
              onParamRef.current("lowCut", nLo);
              onParamRef.current("highCut", nHi);
            }
          } else {
            const i = GRIPS.indexOf(d.grip);
            const rect: RailRect = { x: i * c.colW, y: c.railTop, w: c.colW, h: c.railBot - c.railTop };
            onParamRef.current(d.grip.param, gripVal(d.grip, dragRail(pt.y, rect)));
          }
          return;
        }
        if (inRibbon(pt.y)) {
          const c = ctxRef.current;
          const grip = c.w < NARROW_PX ? RIBBON_GRIP_PX * 1.6 : RIBBON_GRIP_PX;
          const kind = hitFreqRibbon(pt.x, pt.y, { x: 0, y: c.ribbonY, w: c.w, h: c.ribbonH }, params.current.lowCut, params.current.highCut, grip);
          if (kind !== hover.current) {
            hover.current = kind;
            redraw();
          }
          return;
        }
        const g = gripAt(pt.x, pt.y);
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
        if (inRibbon(pt.y)) {
          e.preventDefault();
          onParam("lowCut", 20);
          onParam("highCut", 18000);
          redraw();
          return;
        }
        const g = gripAt(pt.x, pt.y);
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

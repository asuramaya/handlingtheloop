import { useEffect, useRef } from "react";
import { GATE_SHAPES, type Deck, type GateFx } from "@htl/audio";
import { drawReadout, READOUT_H } from "./Readout";

// WYSIWYG for the trance GATE: the GATE ENVELOPE is the star, full-width. The canvas tiles
// several gate cycles across the width as a bright glowing shape — exactly the gain the audio
// is multiplied by — with a vertical PLAYHEAD sweeping at the live rate, while the program
// audio rides UNDER it as a dim level band (gated by the same envelope, so you SEE it chopped).
// Doubles as an XY pad: drag X = RATE, Y = DEPTH. The shared Readout strip is embedded directly
// in this canvas (no curve-preview sibling to fight for width, same as CRUSH) — SHAPE on the
// left, live RATE/DEPTH while dragging in the middle, DUTY/SMOOTH — the two params the drawn
// envelope's own shape doesn't spell out in numbers — on the right.

const CYCLES = 6; // gate cycles drawn across the (now full-width) canvas
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface GateVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
}

export function GateViz({ deck, slot, accent, set }: GateVizProps) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = mainRef.current;
    const dev = deck.fxDeviceAt(slot) as GateFx | undefined;
    if (!canvas || !dev) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev.output.context;
    const an = actx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    dev.output.connect(an); // tap the gated output for the live level band
    const buf = new Float32Array(an.fftSize);

    let raf = 0;
    const draw = () => {
      // keep the synced gate locked to live tempo
      const bpm = deck.effectiveBpm;
      if (bpm) dev.setSyncBpm(bpm);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);
      const vizH = Math.max(1, h - READOUT_H);
      ctx2d.save();
      ctx2d.translate(0, READOUT_H);

      // live output level (RMS) — the dim audio band the gate is chopping
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const lvl = clamp01(Math.sqrt(rms) * 1.6);
      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 9%, transparent)`;
      ctx2d.fillRect(0, vizH - lvl * vizH, w, lvl * vizH);

      const ph = (actx.currentTime * dev.freqHz) % 1; // current phase within the cycle

      // THE STAR — the gate envelope tiled across CYCLES, bright and glowing. Phase advances
      // left→right so the wave appears to flow through the playhead.
      ctx2d.beginPath();
      const N = Math.max(8, Math.round(w));
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * w;
        const p = (i / N) * CYCLES + ph; // scroll with phase
        const g = dev.gateShape(p);
        const y = vizH - g * vizH * 0.96;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
      }
      ctx2d.lineTo(w, vizH);
      ctx2d.lineTo(0, vizH);
      ctx2d.closePath();
      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 20%, transparent)`;
      ctx2d.fill();

      ctx2d.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * w;
        const p = (i / N) * CYCLES + ph;
        const y = vizH - dev.gateShape(p) * vizH * 0.96;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
      }
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 2;
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = 8;
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;

      // cycle boundary ticks (the beats) — faint guides
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} 12%, transparent)`;
      ctx2d.lineWidth = 1;
      for (let c = 1; c < CYCLES; c++) {
        const x = (c / CYCLES) * w;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, vizH);
        ctx2d.stroke();
      }

      ctx2d.restore();

      // The readout — LEFT: what the device IS (shape). MIDDLE: what you're TOUCHING (live
      // RATE/DEPTH while dragging the XY pad, blank at rest). RIGHT: DUTY/SMOOTH — the two
      // params the drawn envelope shape itself doesn't spell out in numbers.
      const shapeIdx = Math.round(dev.getParam("shape"));
      const duty = clamp01(dev.getParam("duty"));
      const smooth = clamp01(dev.getParam("smooth"));
      const rateLabel = dev.synced ? dev.divLabel : `${dev.freqHz.toFixed(1)}Hz`;
      drawReadout(ctx2d, w, accent, {
        left: `${GATE_SHAPES[shapeIdx] ?? "?"}`,
        right: `DUTY ${Math.round(duty * 100)}%  ·  SMOOTH ${Math.round(smooth * 100)}%`,
        mid: dragging.current ? `RATE ${rateLabel}  ·  DEPTH ${Math.round(clamp01(dev.getParam("depth")) * 100)}%` : "",
        midHot: dragging.current,
      });

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      try {
        dev.output.disconnect(an);
      } catch {
        /* ignore */
      }
    };
  }, [deck, slot, accent]);

  // XY pad: X = RATE, Y = DEPTH (top = more). The readout strip at the top is a label, not a
  // control — Y is measured from below it, same exclusion CRUSH's own embedded readout uses.
  const apply = (e: React.PointerEvent) => {
    const r = mainRef.current?.getBoundingClientRect();
    if (!r) return;
    const vizH = Math.max(1, r.height - READOUT_H);
    set("rate", clamp01((e.clientX - r.left) / r.width));
    set("depth", clamp01(1 - (e.clientY - r.top - READOUT_H) / vizH));
  };
  const onDown = (e: React.PointerEvent) => {
    const r = mainRef.current?.getBoundingClientRect();
    if (r && e.clientY - r.top < READOUT_H) return;
    dragging.current = true;
    mainRef.current?.setPointerCapture(e.pointerId);
    apply(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) apply(e);
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try {
      mainRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fx-viz-row">
      <div className="sat-viz">
        <canvas ref={mainRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
      </div>
    </div>
  );
}

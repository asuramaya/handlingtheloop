import { useEffect, useRef } from "react";
import { CRUSH_MODES, type Deck, type CrushFx } from "@htl/audio";
import { drawReadout, READOUT_H } from "./Readout";

// The Pixelator-style WYSIWYG for the bitcrusher. EVERY param has a visual cue:
//   BITS   → horizontal quantization grid rows (fewer rows = coarser).
//   RATE   → the pixel-bar column width (fatter = more downsampled).
//   JITTER → the columns wobble in width (the resample instability).
//   MIX    → a faint DRY "ghost" of the clean input behind + the wet bars' opacity.
//   CUT/RES→ a full-width DAC-reconstruction lowpass backdrop (cutoff position + resonance bump).
//   MODE   → the readout strip's left zone (and the inherent waveform shape: ZERO gaps, VINTAGE
//            ramps…) — the shared Readout primitive, same as every other FX panel's status row.
// Doubles as an XY "pixelate pad": drag X = RATE, Y = BITS (below the readout strip, which is a
// label, not a control).

interface CrushVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function CrushViz({ deck, slot, accent, set }: CrushVizProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const dev0 = deck.fxDeviceAt(slot) as CrushFx | undefined;
    if (!canvas || !dev0) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev0.output.context;
    const wet = actx.createAnalyser();
    wet.fftSize = 1024;
    dev0.output.connect(wet); // tap only
    const dryA = actx.createAnalyser();
    dryA.fftSize = 1024;
    try {
      dev0.input.connect(dryA); // the clean reference (MIX ghost)
    } catch {
      /* ignore */
    }
    const wave = new Float32Array(wet.fftSize);
    const dwave = new Float32Array(dryA.fftSize);
    const hash = (n: number) => {
      const x = Math.sin(n * 12.9898) * 43758.5453;
      return x - Math.floor(x); // deterministic 0..1 (stable wobble, not per-frame flicker)
    };

    let raf = 0;
    const draw = () => {
      // ★ RE-FETCHED EVERY FRAME, never captured once. A device swapped under a live rAF
      // loop (a chain edit, a preset load, a hot reload) leaves the old object still
      // answering getParam() with whatever it held when it was replaced — so the picture
      // simply freezes, with no error anywhere to explain it. Costs one map lookup a frame.
      const dev = (deck.fxDeviceAt(slot) as CrushFx | undefined) ?? dev0;
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
      const center = vizH / 2;
      const amp = vizH * 0.46;
      const bits = dev.bitsValue;
      const rate = dev.rateDiv;
      const mode = dev.modeIndex;
      const mix = dev.getParam("mix");
      const jitter = dev.getParam("jitter");
      const cut = dev.getParam("cut");
      const res = dev.getParam("res");
      const view = wet.fftSize;
      const colPx = (rate / view) * w;
      wet.getFloatTimeDomainData(wave);
      dryA.getFloatTimeDomainData(dwave);

      // BITS → quantization grid rows (capped; brighter when coarse).
      const rows = Math.min(64, Math.round(Math.pow(2, bits)));
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} ${rows <= 24 ? 18 : 7}%, transparent)`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let i = 1; i < rows; i++) {
        const y = (i / rows) * vizH;
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(w, y);
      }
      ctx2d.stroke();

      // CUT/RES → the DAC reconstruction lowpass, drawn FULL-SIZE as a dim BACKDROP behind the
      // scope (one viz, not a mini-window): flat to the cutoff, rolloff after, a resonance bump
      // scaled by RES. Filled under + a soft line, so the pixel bars read on top of it.
      const lp = (t: number) => {
        let g = t < cut ? 1 : Math.max(0, 1 - (t - cut) * 4);
        g += res * Math.exp(-Math.pow((t - cut) * 12, 2)) * 0.9;
        return Math.min(1, g / 1.25);
      };
      const NP = Math.max(2, Math.round(w));
      ctx2d.beginPath();
      ctx2d.moveTo(0, vizH);
      for (let i = 0; i <= NP; i++) {
        const t = i / NP;
        ctx2d.lineTo(t * w, vizH - clamp01(lp(t)) * vizH * 0.92);
      }
      ctx2d.lineTo(w, vizH);
      ctx2d.closePath();
      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 7%, transparent)`;
      ctx2d.fill();
      ctx2d.beginPath();
      for (let i = 0; i <= NP; i++) {
        const t = i / NP;
        const py = vizH - clamp01(lp(t)) * vizH * 0.92;
        i === 0 ? ctx2d.moveTo(t * w, py) : ctx2d.lineTo(t * w, py);
      }
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} 26%, transparent)`;
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();

      // MIX → the clean DRY ghost behind (the reference you compare the crush against).
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} 15%, transparent)`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let i = 0; i < view; i++) {
        const x = (i / (view - 1)) * w;
        const y = center - dwave[i] * amp;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();

      // MIX → the wet result's opacity (more mix = the crush reads louder over the ghost).
      ctx2d.globalAlpha = 0.25 + 0.75 * mix;
      // sample the wet wave at a given x
      const wv = (x: number, cw: number) => wave[Math.min(view - 1, Math.round(((x + cw / 2) / w) * (view - 1)))];
      // JITTER → wobble each column's width deterministically.
      const colW = (ci: number) => Math.max(1, colPx * (1 + (hash(ci) - 0.5) * 2 * jitter * 0.7));

      if (colPx >= 2 && colPx < w) {
        // RATE/JITTER/BITS → blocky pixel bars (fills, then glowing caps).
        ctx2d.fillStyle = `color-mix(in srgb, ${accent} 40%, transparent)`;
        let ci = 0;
        for (let x = 0; x < w; ) {
          const cw = colW(ci);
          const y = center - wv(x, cw) * amp;
          ctx2d.fillRect(x, Math.min(center, y), Math.max(1, cw - 1), Math.max(1, Math.abs(y - center)));
          x += cw;
          ci++;
        }
        ctx2d.shadowColor = accent;
        ctx2d.shadowBlur = 6;
        ctx2d.fillStyle = accent;
        ci = 0;
        for (let x = 0; x < w; ) {
          const cw = colW(ci);
          ctx2d.fillRect(x, center - wv(x, cw) * amp - 1.5, Math.max(1, cw - 1), 3);
          x += cw;
          ci++;
        }
        ctx2d.shadowBlur = 0;
      } else {
        // Near-transparent (rate ≈ 1): smooth glowing filled waveform — no fake blocks.
        ctx2d.beginPath();
        ctx2d.moveTo(0, center);
        for (let i = 0; i < view; i++) ctx2d.lineTo((i / (view - 1)) * w, center - wave[i] * amp);
        ctx2d.lineTo(w, center);
        ctx2d.closePath();
        ctx2d.fillStyle = `color-mix(in srgb, ${accent} 26%, transparent)`;
        ctx2d.fill();
        ctx2d.shadowColor = accent;
        ctx2d.shadowBlur = 5;
        ctx2d.strokeStyle = accent;
        ctx2d.lineWidth = 1.5;
        ctx2d.beginPath();
        for (let i = 0; i < view; i++) {
          const x = (i / (view - 1)) * w;
          const y = center - wave[i] * amp;
          i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      }
      ctx2d.globalAlpha = 1;

      // centre line
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} 22%, transparent)`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(0, center);
      ctx2d.lineTo(w, center);
      ctx2d.stroke();

      ctx2d.restore();

      // The readout — LEFT: what the device IS (mode · mix). MIDDLE: what you're TOUCHING (the
      // XY pad's live bits/rate while dragging, blank at rest). RIGHT: its tone (the CUT/RES
      // lowpass drawn as the backdrop above). Same shared strip every other FX panel uses — MODE
      // used to be its own hand-drawn bottom-left label; now it's just this primitive's left zone.
      const pct = (v: number) => Math.round(clamp01(v) * 100);
      drawReadout(ctx2d, w, accent, {
        left: `${CRUSH_MODES[mode] ?? "?"}  ·  MIX ${pct(mix)}%`,
        right: `CUT ${pct(cut)}%  ·  RES ${pct(res)}%`,
        mid: dragging.current ? `BITS ${bits.toFixed(1)}  ·  RATE ${rate.toFixed(0)}×` : "",
        midHot: dragging.current,
      });

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      try {
        dev0.output.disconnect(wet);
      } catch {
        /* ignore */
      }
      try {
        dev0.input.disconnect(dryA);
      } catch {
        /* ignore */
      }
    };
  }, [deck, slot, accent]);

  // XY pixelate pad: X = RATE (downsample), Y = BITS (top = more crush). The readout strip at the
  // top is a label, not a control — Y is measured from below it, same exclusion Delay/Reverb's
  // hit-testing already gives their own readout row.
  const apply = (e: React.PointerEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const vizH = Math.max(1, r.height - READOUT_H);
    set("rate", clamp01((e.clientX - r.left) / r.width));
    set("bits", clamp01((e.clientY - r.top - READOUT_H) / vizH));
  };
  // ── RESET, the gesture the rest of the rack already has (ValueCell, Knob, ReverbViz's grips,
  // EqCurve, CompViz): double-click or right-click puts this pad back to the device's OWN
  // considered resting values — paramDefault(), never an invented number. A control you can dial
  // but not undial is a control you try once.
  const resetPad = (e: React.MouseEvent) => {
    const dev = deck.fxDeviceAt(slot) as CrushFx | undefined;
    if (!dev) return;
    const r = canvasRef.current?.getBoundingClientRect();
    if (r && e.clientY - r.top < READOUT_H) return; // the strip is not a control
    for (const id of ["rate", "bits"]) set(id, dev.paramDefault(id));
  };
  const onDoubleClick = (e: React.MouseEvent) => resetPad(e);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    resetPad(e);
  };

  const onDown = (e: React.PointerEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (r && e.clientY - r.top < READOUT_H) return;
    dragging.current = true;
    canvasRef.current?.setPointerCapture(e.pointerId);
    apply(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) apply(e);
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fx-viz-row">
      <div className="sat-viz">
        <canvas ref={canvasRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
      </div>
    </div>
  );
}

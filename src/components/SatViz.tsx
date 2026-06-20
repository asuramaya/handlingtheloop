import { useEffect, useRef } from "react";
import type { Deck, SaturatorFx } from "@htl/audio";

// The Saturn-glass WYSIWYG for the multiband saturator. A log-frequency display:
//   • live spectrum of the device output (the "see the distortion" backdrop),
//   • draggable CROSSOVER dividers (drag horizontally → retune the band split),
//   • per-band DRIVE as a fill whose top edge drags vertically,
//   • a transfer-curve readout in the corner (the literal WaveShaper curve = WYSIWYG-exact).
// Direct-control throughout (the EqCurve/ReverbViz pattern): the graph IS the knobs. Reads
// the device's live state each frame; writes through `set` (which mutates + emits + refreshes).

const F_MIN = 20;
const F_MAX = 20000;
const LOG_SPAN = Math.log(F_MAX / F_MIN);
const fx = (hz: number, w: number) => (Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / LOG_SPAN) * w;
const xf = (x: number, w: number) => F_MIN * Math.exp((x / w) * LOG_SPAN);
const hz2ext = (hz: number) => Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / LOG_SPAN;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface SatVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void; // mutate + emit + refresh (from SatPanel)
}

export function SatViz({ deck, slot, accent, set }: SatVizProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ kind: "xover" | "drive"; idx: number; grab: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const dev = deck.fxDeviceAt(slot) as SaturatorFx | undefined;
    if (!canvas || !dev) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev.output.context;
    const analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    dev.output.connect(analyser); // tap only (not forwarded) → no path change
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const BANDS = (dev.constructor as typeof SaturatorFx).BANDS;

    let raf = 0;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      // crossover x positions → band boundaries
      const xo: number[] = [];
      for (let j = 0; j < BANDS - 1; j++) xo.push(fx(dev.xoverHzOf(j), w));
      const edges = [0, ...xo, w];

      // per-band drive fill (top edge = drive level). Hotter drive → warmer fill.
      for (let i = 0; i < BANDS; i++) {
        const x0 = edges[i];
        const x1 = edges[i + 1];
        const d = dev.driveOf(i);
        const top = h - d * h;
        const warm = 0.12 + d * 0.5;
        ctx2d.fillStyle = `color-mix(in srgb, ${accent} ${Math.round(warm * 100)}%, transparent)`;
        ctx2d.fillRect(x0, top, x1 - x0, h - top);
        // the draggable top edge
        ctx2d.strokeStyle = accent;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(x0 + 1, top);
        ctx2d.lineTo(x1 - 1, top);
        ctx2d.stroke();
      }

      // live spectrum line (output) over the top
      analyser.getByteFrequencyData(bins);
      const nyq = actx.sampleRate / 2;
      ctx2d.strokeStyle = "rgba(255,255,255,0.55)";
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      let started = false;
      for (let b = 1; b < bins.length; b++) {
        const f = (b / bins.length) * nyq;
        if (f < F_MIN) continue;
        if (f > F_MAX) break;
        const x = fx(f, w);
        const y = h - (bins[b] / 255) * h * 0.95;
        if (!started) {
          ctx2d.moveTo(x, y);
          started = true;
        } else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();

      // crossover dividers (draggable)
      ctx2d.strokeStyle = "rgba(255,255,255,0.85)";
      ctx2d.lineWidth = 1.5;
      for (const x of xo) {
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
      }

      // transfer-curve readout (bottom-right): the literal WaveShaper curve = WYSIWYG
      const cs = Math.min(72, w * 0.32, h * 0.6);
      const cx = w - cs - 6;
      const cy = h - cs - 6;
      ctx2d.fillStyle = "rgba(0,0,0,0.45)";
      ctx2d.fillRect(cx, cy, cs, cs);
      ctx2d.strokeStyle = "rgba(255,255,255,0.18)";
      ctx2d.lineWidth = 1;
      ctx2d.strokeRect(cx, cy, cs, cs);
      ctx2d.beginPath();
      ctx2d.moveTo(cx, cy + cs / 2);
      ctx2d.lineTo(cx + cs, cy + cs / 2);
      ctx2d.moveTo(cx + cs / 2, cy);
      ctx2d.lineTo(cx + cs / 2, cy + cs);
      ctx2d.stroke();
      // The EFFECTIVE transfer from the input: drive (hottest band) pushes the signal toward
      // the saturated edges, bias shifts it (asymmetry). So the readout reacts to drive/bias/
      // style/punish — not just the raw style curve.
      const curve = dev.curveFor();
      const L = curve.length;
      let dmax = 0;
      for (let i = 0; i < BANDS; i++) dmax = Math.max(dmax, dev.driveOf(i));
      const g = Math.pow(10, dmax);
      const bias = dev.getParam("bias") * 0.4;
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      for (let px = 0; px <= cs; px++) {
        const inp = (px / cs) * 2 - 1;
        let driven = g * inp + bias;
        if (driven < -1) driven = -1;
        else if (driven > 1) driven = 1;
        const idx = Math.round(((driven + 1) / 2) * (L - 1));
        const x = cx + px;
        const y = cy + cs / 2 - (curve[idx] * cs) / 2;
        px === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      try {
        dev.output.disconnect(analyser);
      } catch {
        /* already gone */
      }
    };
  }, [deck, slot, accent]);

  // Hit-test on press: near a crossover line → drag it; inside a band → drag its drive.
  const onDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    const dev = deck.fxDeviceAt(slot) as SaturatorFx | undefined;
    if (!canvas || !dev) return;
    const r = canvas.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const BANDS = (dev.constructor as typeof SaturatorFx).BANDS;
    // crossover grab (within 8 px)
    for (let j = 0; j < BANDS - 1; j++) {
      if (Math.abs(x - fx(dev.xoverHzOf(j), w)) < 8) {
        drag.current = { kind: "xover", idx: j, grab: 0 };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }
    // else which band region
    const xo: number[] = [];
    for (let j = 0; j < BANDS - 1; j++) xo.push(fx(dev.xoverHzOf(j), w));
    let band = 0;
    while (band < xo.length && x > xo[band]) band++;
    drag.current = { kind: "drive", idx: band, grab: 0 };
    canvas.setPointerCapture(e.pointerId);
    set(`drive${band}`, clamp01(1 - y / h));
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const r = canvas.getBoundingClientRect();
    if (d.kind === "xover") {
      const hz = xf(e.clientX - r.left, r.width);
      set(`xover${d.idx}`, clamp01(hz2ext(hz)));
    } else {
      set(`drive${d.idx}`, clamp01(1 - (e.clientY - r.top) / r.height));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="sat-viz">
      <canvas ref={canvasRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
    </div>
  );
}

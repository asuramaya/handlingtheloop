import { useEffect, useRef } from "react";
import type { Deck, ModFx } from "@htl/audio";
import { drawCurvePanel, fitCanvas } from "./curveInset";

// WYSIWYG for the modulation device: a live LOG-frequency spectrum of the output, so the
// comb peaks (chorus/flanger) and the notches (phaser) are visible — and they SWEEP with the
// LFO/envelope in real time. The standardized curve panel on the right shows the LFO
// WAVEFORM. Doubles as an XY mod pad: drag X = RATE, Y = DEPTH.

const F_MIN = 30;
const F_MAX = 20000;
const LS = Math.log(F_MAX / F_MIN);
const fx = (hz: number, w: number) => (Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / LS) * w;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface ModVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
}

export function ModViz({ deck, slot, accent, set }: ModVizProps) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = mainRef.current;
    const dev = deck.fxDeviceAt(slot) as ModFx | undefined;
    if (!canvas || !dev) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev.output.context;
    const an = actx.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0.5;
    dev.output.connect(an); // dim audio backdrop
    const bins = new Uint8Array(an.frequencyBinCount);
    const modAn = actx.createAnalyser(); // the REAL modulation signal (LFO + envelope)
    modAn.fftSize = 256;
    try {
      dev.modSignal.connect(modAn);
    } catch {
      /* ignore */
    }
    const modBuf = new Float32Array(modAn.fftSize);

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
      const nyq = actx.sampleRate / 2;
      an.getByteFrequencyData(bins);
      const yOf = (b: number) => h - (bins[b] / 255) * h * 0.94;

      // filled spectrum body — the comb/notch shape (it sweeps with the modulation)
      ctx2d.beginPath();
      ctx2d.moveTo(0, h);
      let started = false;
      for (let b = 1; b < bins.length; b++) {
        const f = (b / bins.length) * nyq;
        if (f < F_MIN) continue;
        if (f > F_MAX) break;
        const x = fx(f, w);
        if (!started) {
          ctx2d.lineTo(x, h);
          started = true;
        }
        ctx2d.lineTo(x, yOf(b));
      }
      ctx2d.lineTo(w, h);
      ctx2d.closePath();
      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 10%, transparent)`; // DIM audio backdrop
      ctx2d.fill();

      // THE STAR — the sweeping comb/notch positions from the REAL mod signal (LFO + env),
      // bright glowing vertical lines that move with the modulation (the audio is just context).
      modAn.getFloatTimeDomainData(modBuf);
      const m = modBuf[modBuf.length - 1] || 0;
      const targets = dev.modTargets(m);
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = 7;
      for (let i = 0; i < targets.length; i++) {
        const x = fx(targets[i], w);
        const a = Math.max(22, Math.round(95 - i * 7));
        ctx2d.strokeStyle = `color-mix(in srgb, ${accent} ${a}%, transparent)`;
        ctx2d.lineWidth = i === 0 ? 2.6 : 1.4;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
      }
      ctx2d.shadowBlur = 0;

      // LFO waveform in the standardized curve panel + a moving PLAYHEAD dot (the modulation,
      // foregrounded). Phase reconstructed from the LFO rate; the dot rides the wave.
      const cc = curveRef.current;
      if (cc) {
        const f = fitCanvas(cc);
        if (f.ctx) {
          const wave = Math.round(dev.getParam("wave"));
          const shape = (t: number) => {
            const s = Math.sin(2 * Math.PI * t);
            return wave === 1 ? Math.asin(s) * (2 / Math.PI) : wave === 2 ? (s >= 0 ? 1 : -1) : s;
          };
          drawCurvePanel(f.ctx, f.w, f.h, accent, shape, { bipolar: true });
          const ph = (actx.currentTime * dev.rateHz) % 1;
          const pad = 5;
          const iw = f.w - pad * 2;
          const ih = f.h - pad * 2;
          const dx = pad + ph * iw;
          const dy = pad + ih / 2 - shape(ph) * (ih / 2) * 0.92;
          f.ctx.fillStyle = accent;
          f.ctx.shadowColor = accent;
          f.ctx.shadowBlur = 7;
          f.ctx.beginPath();
          f.ctx.arc(dx, dy, 3, 0, 2 * Math.PI);
          f.ctx.fill();
          f.ctx.shadowBlur = 0;
        }
      }

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
      try {
        dev.modSignal.disconnect(modAn);
      } catch {
        /* ignore */
      }
    };
  }, [deck, slot, accent]);

  // XY mod pad: X = RATE, Y = DEPTH (top = more).
  const apply = (e: React.PointerEvent) => {
    const r = mainRef.current?.getBoundingClientRect();
    if (!r) return;
    set("rate", clamp01((e.clientX - r.left) / r.width));
    set("depth", clamp01(1 - (e.clientY - r.top) / r.height));
  };
  const onDown = (e: React.PointerEvent) => {
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
      <div className="fx-curve">
        <canvas ref={curveRef} className="fx-curve-canvas" />
      </div>
    </div>
  );
}

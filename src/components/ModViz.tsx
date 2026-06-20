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
    dev.output.connect(an); // tap only
    const bins = new Uint8Array(an.frequencyBinCount);

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
      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 26%, transparent)`;
      ctx2d.fill();

      // glowing outline
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 1.4;
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = 4;
      ctx2d.beginPath();
      started = false;
      for (let b = 1; b < bins.length; b++) {
        const f = (b / bins.length) * nyq;
        if (f < F_MIN) continue;
        if (f > F_MAX) break;
        const x = fx(f, w);
        started ? ctx2d.lineTo(x, yOf(b)) : (ctx2d.moveTo(x, yOf(b)), (started = true));
      }
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;

      // LFO waveform in the standardized curve panel.
      const cc = curveRef.current;
      if (cc) {
        const f = fitCanvas(cc);
        if (f.ctx) {
          const wave = Math.round(dev.getParam("wave"));
          drawCurvePanel(
            f.ctx,
            f.w,
            f.h,
            accent,
            (t) => {
              const s = Math.sin(2 * Math.PI * t);
              return wave === 1 ? Math.asin(s) * (2 / Math.PI) : wave === 2 ? (s >= 0 ? 1 : -1) : s;
            },
            { bipolar: true },
          );
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

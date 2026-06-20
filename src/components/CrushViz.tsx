import { useEffect, useRef } from "react";
import type { Deck, CrushFx } from "@htl/audio";

// The Pixelator-style WYSIWYG for the bitcrusher: a live time-domain scope of the crushed
// output drawn over the QUANTIZATION GRID — horizontal lines at the bit-depth levels +
// faint vertical columns at the sample-hold width. You literally watch the resolution drop
// as BITS/RATE move. Doubles as an XY "pixelate pad": drag X = RATE (downsample), Y = BITS.

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
    const dev = deck.fxDeviceAt(slot) as CrushFx | undefined;
    if (!canvas || !dev) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev.output.context;
    const analyser = actx.createAnalyser();
    analyser.fftSize = 1024;
    dev.output.connect(analyser); // tap only
    const wave = new Float32Array(analyser.fftSize);

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

      // Quantization GRID — horizontal lines at the bit levels (capped so 16-bit isn't a wall),
      // brighter as the depth drops so heavy crush reads as a coarse pixel grid.
      const bits = dev.bitsValue;
      const levels = Math.pow(2, bits);
      const lines = Math.min(48, Math.round(levels));
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} ${lines <= 24 ? 22 : 8}%, transparent)`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let i = 1; i < lines; i++) {
        const y = (i / lines) * h;
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(w, y);
      }
      // Sample-hold COLUMNS — vertical lines at the decimation width (the "pixel" cells).
      const rate = dev.rateDiv;
      const view = analyser.fftSize; // samples shown across the width
      const colPx = (rate / view) * w;
      if (colPx >= 3 && colPx < w) {
        for (let x = 0; x < w; x += colPx) {
          ctx2d.moveTo(x, 0);
          ctx2d.lineTo(x, h);
        }
      }
      ctx2d.stroke();

      // The crushed waveform (staircase) over the grid.
      analyser.getFloatTimeDomainData(wave);
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      for (let i = 0; i < view; i++) {
        const x = (i / (view - 1)) * w;
        const y = h / 2 - wave[i] * h * 0.46;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
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

  // XY pixelate pad: X = RATE (downsample), Y = BITS (top = more crush).
  const apply = (e: React.PointerEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    set("rate", clamp01((e.clientX - r.left) / r.width));
    set("bits", clamp01((e.clientY - r.top) / r.height));
  };
  const onDown = (e: React.PointerEvent) => {
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
    <div className="sat-viz">
      <canvas ref={canvasRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
    </div>
  );
}

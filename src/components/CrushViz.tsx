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
      const center = h / 2;
      const amp = h * 0.46;
      const bits = dev.bitsValue;
      const rate = dev.rateDiv;
      const view = analyser.fftSize;
      const colPx = (rate / view) * w; // pixel width of one sample-hold "pixel"
      analyser.getFloatTimeDomainData(wave);

      // Quantization GRID — horizontal lines at the bit levels (capped so 16-bit isn't a wall),
      // brighter as the depth drops so heavy crush reads as a coarse pixel grid.
      const rows = Math.min(64, Math.round(Math.pow(2, bits)));
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} ${rows <= 24 ? 18 : 7}%, transparent)`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let i = 1; i < rows; i++) {
        const y = (i / rows) * h;
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(w, y);
      }
      ctx2d.stroke();

      if (colPx >= 2 && colPx < w) {
        // BLOCKY: one filled "pixel" bar per hold-column from the centre to the held value —
        // the bars get fatter as RATE rises and snap to fewer rows as BITS drops. Two passes
        // (fills, then glowing caps) so the glow toggles once, not per column.
        ctx2d.fillStyle = `color-mix(in srgb, ${accent} 40%, transparent)`;
        for (let x = 0; x < w; x += colPx) {
          const v = wave[Math.min(view - 1, Math.round(((x + colPx / 2) / w) * (view - 1)))];
          const y = center - v * amp;
          const top = Math.min(center, y);
          ctx2d.fillRect(x, top, Math.max(1, colPx - 1), Math.max(1, Math.abs(y - center)));
        }
        ctx2d.shadowColor = accent;
        ctx2d.shadowBlur = 6;
        ctx2d.fillStyle = accent;
        for (let x = 0; x < w; x += colPx) {
          const v = wave[Math.min(view - 1, Math.round(((x + colPx / 2) / w) * (view - 1)))];
          ctx2d.fillRect(x, center - v * amp - 1.5, Math.max(1, colPx - 1), 3); // bright cap = the pixel top
        }
        ctx2d.shadowBlur = 0;
      } else {
        // Near-transparent (rate ≈ 1): a smooth glowing filled waveform — no fake blocks.
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

      // centre line
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} 22%, transparent)`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(0, center);
      ctx2d.lineTo(w, center);
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

import { useEffect, useRef } from "react";
import type { Deck, NoiseFx } from "@htl/audio";

// WYSIWYG for the NOISE riser: a log-frequency display where the LIVE generated noise spectrum
// fills in as you engage (dim when idle), the resonant SWEEP filter response glows over it, and
// a marker rides the cutoff — so during an auto-build you watch the whole thing CLIMB. The
// standardized curve panel (right) shows the filter response shape. XY pad: X = SWEEP, Y = RES.

const F_MIN = 30;
const F_MAX = 20000;
const LS = Math.log(F_MAX / F_MIN);
const fx = (hz: number, w: number) => (Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / LS) * w;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface NoiseVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
}

export function NoiseViz({ deck, slot, accent, set }: NoiseVizProps) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = mainRef.current;
    const dev = deck.fxDeviceAt(slot) as NoiseFx | undefined;
    if (!canvas || !dev) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev.output.context;
    const an = actx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    dev.output.connect(an);
    const bins = new Uint8Array(an.frequencyBinCount);

    // log-spaced freqs for the filter-response read (reused for main curve + inset)
    const NR = 160;
    const freqs = new Float32Array(NR);
    for (let i = 0; i < NR; i++) freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (NR - 1));
    const resp = new Float32Array(NR);

    let raf = 0;
    const draw = () => {
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
      const nyq = actx.sampleRate / 2;

      // BARS build meter — FULL-HEIGHT bar columns spanning the whole viz, drawn FIRST as a
      // backdrop so the spectrum + sweep curve render on top. One column per bar, filled to the
      // live build progress + a leading playhead. RISE off = a "MANUAL" label.
      drawRiseBars(ctx2d, w, h, accent, dev);

      // live generated-noise spectrum — fills in as the riser is engaged (dim until then).
      an.getByteFrequencyData(bins);
      ctx2d.beginPath();
      ctx2d.moveTo(0, h);
      let started = false;
      for (let b = 1; b < bins.length; b++) {
        const f = (b / bins.length) * nyq;
        if (f < F_MIN) continue;
        if (f > F_MAX) break;
        const x = fx(f, w);
        const y = h - (bins[b] / 255) * h * 0.94;
        if (!started) {
          ctx2d.lineTo(x, h);
          started = true;
        }
        ctx2d.lineTo(x, y);
      }
      ctx2d.lineTo(w, h);
      ctx2d.closePath();
      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 22%, transparent)`;
      ctx2d.fill();

      // the SWEEP filter response (resonant high-pass × tone low-pass), normalized — the glowing
      // shape that climbs as the cutoff rises. THIS is the star (visible even when silent).
      dev.getResponse(freqs as Float32Array<ArrayBuffer>, resp as Float32Array<ArrayBuffer>);
      let mx = 0.0001;
      for (let i = 0; i < NR; i++) mx = Math.max(mx, resp[i]);
      ctx2d.beginPath();
      for (let i = 0; i < NR; i++) {
        const x = fx(freqs[i], w);
        const y = h - clamp01(resp[i] / mx) * h * 0.92;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
      }
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 2;
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = 8;
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;

      // cutoff marker — rides the sweep, brighter while engaged.
      const mxx = fx(dev.sweepHz, w);
      ctx2d.strokeStyle = `color-mix(in srgb, ${accent} ${dev.throwing ? 95 : 45}%, transparent)`;
      ctx2d.lineWidth = dev.throwing ? 2.4 : 1.4;
      ctx2d.beginPath();
      ctx2d.moveTo(mxx, 0);
      ctx2d.lineTo(mxx, h);
      ctx2d.stroke();

      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 70%, transparent)`;
      ctx2d.font = "10px ui-monospace, monospace";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(dev.throwing ? (dev.rising ? "RISE" : "ON") : "", 6, 5);

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

  // XY pad: X = SWEEP, Y = RES (top = more resonance).
  const apply = (e: React.PointerEvent) => {
    const r = mainRef.current?.getBoundingClientRect();
    if (!r) return;
    set("sweep", clamp01((e.clientX - r.left) / r.width));
    set("res", clamp01(1 - (e.clientY - r.top) / r.height));
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
    </div>
  );
}

// The BARS build meter — FULL-HEIGHT bar columns spanning the whole viz, drawn as a backdrop
// behind the spectrum + sweep curve. One column per bar, filled bottom-up to the live build
// progress with a bright leading playhead, so you watch the rise march bar-by-bar to the drop.
// RISE off = an instant gate, so it reads "MANUAL".
function drawRiseBars(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string, dev: NoiseFx) {
  if (!dev.rising) {
    ctx.fillStyle = `color-mix(in srgb, ${accent} 26%, transparent)`;
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("MANUAL", w - 8, 6);
    ctx.textAlign = "left";
    return;
  }

  const bars = Math.max(1, Math.round(dev.bars));
  const prog = dev.riseProgress; // -1 when idle (armed but not yet building)
  const gap = 3;
  const cellW = (w - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i++) {
    const cx = i * (cellW + gap);
    // full-height column: a faint base so the segment is visible, then a bottom-up fill.
    ctx.fillStyle = `color-mix(in srgb, ${accent} 7%, transparent)`;
    ctx.fillRect(cx, 0, cellW, h);
    ctx.strokeStyle = `color-mix(in srgb, ${accent} 16%, transparent)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx + 0.5, 0.5, cellW - 1, h - 1);
    const fill = prog >= 0 ? clamp01(prog * bars - i) : 0; // this column's fill fraction
    if (fill > 0) {
      const fh = h * fill;
      ctx.fillStyle = `color-mix(in srgb, ${accent} ${Math.round(14 + 22 * fill)}%, transparent)`;
      ctx.fillRect(cx, h - fh, cellW, fh);
    }
  }

  // leading playhead — a glowing vertical line at the live build position.
  if (prog >= 0) {
    const hx = clamp01(prog) * w;
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.fillRect(hx - 1, 0, 2, h);
    ctx.shadowBlur = 0;
  }

  // bar-count label, top-right.
  ctx.fillStyle = `color-mix(in srgb, ${accent} 55%, transparent)`;
  ctx.font = "700 10px ui-monospace, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillText(`${bars} BAR${bars > 1 ? "S" : ""}`, w - 8, 6);
  ctx.textAlign = "left";
}

import { useEffect, useRef, useState } from "react";
import type { Deck } from "@htl/audio";
import { SaturatorFx, SAT_STYLES } from "@htl/audio";
import { drawCurvePanel, fitCanvas } from "./curveInset";
import { MeterBar } from "./MeterBar";
import { drawReadout, READOUT_H } from "./Readout";
import { fmtHz, fmtDb } from "../util/format";

// The Saturn-glass WYSIWYG for the multiband saturator. A log-frequency display:
//   • live spectrum of the device output (the "see the distortion" backdrop),
//   • draggable CROSSOVER dividers (drag horizontally → retune the band split),
//   • per-band DRIVE as a fill whose top edge drags vertically — pressing inside a band also
//     SELECTS it (mirrors the EQ's "touching a node selects its band"): the parent renders that
//     band's own STYLE/PUNISH/BIAS subrow below, since each band now carries its own character,
//   • a transfer-curve readout in the corner (the literal WaveShaper curve — WYSIWYG-exact; a
//     band on the TAPE worklet has no such curve, since a stateful process has no single-valued
//     input→output function, so that panel shows a label instead),
//   • an output-level meter, reading the SAME analyser already tapped for the spectrum.
// Direct-control throughout (the EqCurve/ReverbViz pattern): the graph IS the knobs. Reads the
// device's live state each frame; writes through `set` (which mutates + emits + refreshes).

const F_MIN = 20;
const F_MAX = 20000;
const LOG_SPAN = Math.log(F_MAX / F_MIN);
const fx = (hz: number, w: number) => (Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / LOG_SPAN) * w;
const xf = (x: number, w: number) => F_MIN * Math.exp((x / w) * LOG_SPAN);
const hz2ext = (hz: number) => Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / LOG_SPAN;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const driveDb = (ext: number) => ((clamp01(ext) * 30 - 10)); // mirrors SaturatorFx's own driveGain mapping, in dB

interface SatVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void; // mutate + emit + refresh (from SatPanel)
  sel: number; // the band whose subrow the parent is showing
  onSelect: (i: number) => void;
}

export function SatViz({ deck, slot, accent, set, sel, onSelect }: SatVizProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<HTMLCanvasElement>(null);
  const meterPeak = useRef(0); // 0..1 linear peak, read by MeterBar's own rAF
  // Whether `sel`'s band is currently on the TAPE worklet — React state (not a ref) because the
  // curve-panel label needs a re-render, but only bumped on an actual CHANGE (see the draw loop
  // below), not every animation frame.
  const [isWorklet, setIsWorklet] = useState(false);
  const isWorkletRef = useRef(false);
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
    const timeBuf = new Float32Array(analyser.fftSize);
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

      // per-band drive fill (top edge = drive level). Hotter drive → warmer fill. The SELECTED
      // band gets a bright border (mirrors the EQ node's `.selected` ring); each band's own
      // style name is labelled so the whole device's character is readable at a glance without
      // having to select every band in turn.
      for (let i = 0; i < BANDS; i++) {
        const x0 = edges[i];
        const x1 = edges[i + 1];
        const d = dev.driveOf(i);
        const top = h - d * h;
        const warm = 0.12 + d * 0.5;
        ctx2d.fillStyle = `color-mix(in srgb, ${accent} ${Math.round(warm * 100)}%, transparent)`;
        ctx2d.fillRect(x0, top, x1 - x0, h - top);
        ctx2d.strokeStyle = accent;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(x0 + 1, top);
        ctx2d.lineTo(x1 - 1, top);
        ctx2d.stroke();

        if (i === sel) {
          ctx2d.strokeStyle = "rgba(255,255,255,0.55)";
          ctx2d.lineWidth = 1.5;
          ctx2d.setLineDash([3, 3]);
          ctx2d.strokeRect(x0 + 1.5, 1.5, x1 - x0 - 3, h - 3);
          ctx2d.setLineDash([]);
        }
        const punished = dev.punishOf(i);
        ctx2d.font = punished ? "800 10px system-ui, sans-serif" : "700 10px system-ui, sans-serif";
        ctx2d.fillStyle = punished ? accent : "rgba(255,255,255,0.55)";
        ctx2d.textAlign = "center";
        ctx2d.fillText(SAT_STYLES[dev.styleOf(i)] ?? "?", (x0 + x1) / 2, 13);
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

      // The readout — its OWN full-width canvas above fx-viz-row, not squeezed inside this one
      // (which is narrower than the panel: the curve-preview panel sits to its right). LEFT: the
      // SELECTED band's character. MIDDLE: what you're TOUCHING (blank when you aren't). RIGHT:
      // that band's drive. Same 3-zone contract as Delay/Reverb — one law for every FX panel's
      // status text, not a per-device tooltip reinvented each time.
      const rcanvas = readoutRef.current;
      const rctx = rcanvas?.getContext("2d");
      if (rcanvas && rctx) {
        const rw = rcanvas.clientWidth;
        const rh = rcanvas.clientHeight;
        if (rcanvas.width !== Math.round(rw * dpr) || rcanvas.height !== Math.round(rh * dpr)) {
          rcanvas.width = Math.round(rw * dpr);
          rcanvas.height = Math.round(rh * dpr);
        }
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, rw, rh);
        const d = drag.current;
        const midLabel =
          d?.kind === "xover" ? `${fmtHz(dev.xoverHzOf(d.idx))} Hz`
          : d?.kind === "drive" ? `${fmtDb(driveDb(dev.driveOf(d.idx)))} dB`
          : "";
        drawReadout(rctx, rw, accent, {
          left: `${SAT_STYLES[dev.styleOf(sel)] ?? "?"}  ·  HEAT ${Math.round(dev.heatOf(sel) * 100)}%`,
          right: `${fmtDb(driveDb(dev.driveOf(sel)))} dB`,
          mid: midLabel,
          midHot: !!d,
        });
      }

      // Output peak, from the SAME analyser tap (no second node needed).
      analyser.getFloatTimeDomainData(timeBuf);
      let peak = 0;
      for (let i = 0; i < timeBuf.length; i++) peak = Math.max(peak, Math.abs(timeBuf[i]));
      meterPeak.current = peak;

      // The EFFECTIVE transfer readout for the SELECTED band, in its own panel to the right:
      // drive (that band's own) pushes the input toward the saturated/folded edges, bias shifts
      // it (asymmetry) — so it reacts to that band's drive/bias/style/punish, not just the raw
      // style curve. Null (the TAPE worklet has no single-valued curve) clears the panel — the
      // parent overlays a label in that case.
      const curve = dev.curveFor(sel);
      const nowWorklet = curve == null;
      if (nowWorklet !== isWorkletRef.current) {
        isWorkletRef.current = nowWorklet;
        setIsWorklet(nowWorklet);
      }
      const cc = curveRef.current;
      if (cc && curve) {
        const f = fitCanvas(cc);
        if (f.ctx) {
          const L = curve.length;
          const g = Math.pow(10, dev.driveOf(sel));
          const bias = dev.biasOf(sel) * 0.4;
          drawCurvePanel(
            f.ctx,
            f.w,
            f.h,
            accent,
            (t) => {
              const driven = Math.max(-1, Math.min(1, g * (t * 2 - 1) + bias));
              return curve[Math.round(((driven + 1) / 2) * (L - 1))];
            },
            { bipolar: true },
          );
        }
      } else if (cc) {
        const f = fitCanvas(cc);
        if (f.ctx) f.ctx.clearRect(0, 0, f.w, f.h);
      }

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
  }, [deck, slot, accent, sel]);

  // Hit-test on press: near a crossover line → drag it; inside a band → drag its drive AND
  // select that band (the parent shows its style/punish/bias subrow below).
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
    onSelect(band);
    set(`drive${band}`, clamp01(1 - y / h));
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!d) return;
    if (d.kind === "xover") {
      const hz = xf(e.clientX - r.left, r.width);
      set(`xover${d.idx}`, clamp01(hz2ext(hz)));
    } else {
      const v = clamp01(1 - (e.clientY - r.top) / r.height);
      set(`drive${d.idx}`, v);
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
    <>
      <div className="sat-status">
        <canvas ref={readoutRef} className="sat-readout" style={{ height: READOUT_H }} />
        <div className="fx-viz-row">
          <div className="sat-viz">
            <canvas ref={canvasRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
          </div>
          <div className="fx-curve">
            <canvas ref={curveRef} className="fx-curve-canvas" />
            {isWorklet && <span className="sat-curve-worklet">◆ HYSTERESIS</span>}
          </div>
        </div>
        <MeterBar getValue={() => meterPeak.current} toPercent={(p) => Math.max(0, (20 * Math.log10(p || 1e-6) + 40) * 2.5)} format={(p) => (p < 1e-3 ? "-inf" : (20 * Math.log10(p)).toFixed(1))} unit="dBFS" label="Output level" className="sat-meter" />
      </div>
    </>
  );
}

import { useEffect, useRef } from "react";
import { NOISE_DIRS, NOISE_TYPES, type Deck, type NoiseFx } from "@htl/audio";
import { drawReadout, READOUT_H } from "./Readout";

// WYSIWYG for the NOISE riser: a log-frequency display where the LIVE generated noise spectrum
// fills in as you engage (dim when idle), the resonant SWEEP filter response glows over it, and
// a marker rides the cutoff — so during an auto-build you watch the whole thing CLIMB. The
// standardized curve panel (right) shows the filter response shape. XY pad: X = SWEEP, Y = RES.
//
// The shared Readout strip is drawn into the TOP of this canvas (the CRUSH/GATE mounting — no
// curve-preview sibling to fight for width): LEFT what the device IS (colour · build length),
// MIDDLE what you're TOUCHING on the pad, RIGHT the tone. NOISE was the last device in the rack
// without one.

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
    const dev0 = deck.fxDeviceAt(slot) as NoiseFx | undefined;
    if (!canvas || !dev0) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev0.output.context;
    const an = actx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    dev0.output.connect(an);
    const bins = new Uint8Array(an.frequencyBinCount);

    // log-spaced freqs for the filter-response read (reused for main curve + inset)
    const NR = 160;
    const freqs = new Float32Array(NR);
    for (let i = 0; i < NR; i++) freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (NR - 1));
    const resp = new Float32Array(NR);

    let raf = 0;
    const draw = () => {
      // ★ RE-FETCHED EVERY FRAME, never captured once. A device swapped under a live rAF
      // loop (a chain edit, a preset load, a hot reload) leaves the old object still
      // answering getParam() with whatever it held when it was replaced — so the picture
      // simply freezes, with no error anywhere to explain it. Costs one map lookup a frame.
      const dev = (deck.fxDeviceAt(slot) as NoiseFx | undefined) ?? dev0;
      const bpm = deck.effectiveBpm;
      if (bpm) dev.setSyncBpm(bpm);
      // The bar grid a SNAPped build lands on, and the key TONAL follows — both from the deck,
      // both the same sources the waveform and the key badge already read, so the riser lands on
      // the line you can see and sings in the key the header names.
      dev.setGrid(deck.barGridCtx());
      const key = deck.effectiveKey;
      // tonic pitch class → Hz, in the octave a riser's pitched layer wants to start from
      // (~65‥123 Hz, i.e. C2 up): 16.3516 is C0.
      dev.setKeyHz(key ? 16.3516 * Math.pow(2, key.tonic / 12) * 4 : 0);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);
      // Everything below draws in a frame translated under the readout strip; `h` from here on
      // is the GRAPH's height, so no drawing can land on the strip (the CrushViz pattern).
      const boxH = h;
      const h2 = Math.max(1, boxH - READOUT_H);
      ctx2d.save();
      ctx2d.translate(0, READOUT_H);
      const nyq = actx.sampleRate / 2;

      // BARS build meter — FULL-HEIGHT bar columns spanning the whole viz, drawn FIRST as a
      // backdrop so the spectrum + sweep curve render on top. One column per bar, filled to the
      // live build progress + a leading playhead. RISE off = a "MANUAL" label.
      drawRiseBars(ctx2d, w, h2, accent, dev);

      // live generated-noise spectrum — fills in as the riser is engaged (dim until then).
      an.getByteFrequencyData(bins);
      ctx2d.beginPath();
      ctx2d.moveTo(0, h2);
      let started = false;
      for (let b = 1; b < bins.length; b++) {
        const f = (b / bins.length) * nyq;
        if (f < F_MIN) continue;
        if (f > F_MAX) break;
        const x = fx(f, w);
        const y = h2 - (bins[b] / 255) * h2 * 0.94;
        if (!started) {
          ctx2d.lineTo(x, h2);
          started = true;
        }
        ctx2d.lineTo(x, y);
      }
      ctx2d.lineTo(w, h2);
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
        const y = h2 - clamp01(resp[i] / mx) * h2 * 0.92;
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
      ctx2d.lineTo(mxx, h2);
      ctx2d.stroke();

      ctx2d.fillStyle = `color-mix(in srgb, ${accent} 70%, transparent)`;
      ctx2d.font = "10px ui-monospace, monospace";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(dev.throwing ? (dev.rising ? "RISE" : "ON") : "", 6, 5);

      ctx2d.restore();

      // The readout. LEFT: what the device IS — the noise colour, and the build it will run (or
      // MANUAL, when the pad is a plain gate). MIDDLE: what you're touching on the XY pad. RIGHT:
      // the post tone, the one control the drawn sweep curve doesn't spell out as a number.
      const bars = Math.max(1, Math.round(dev.bars));
      // SNAP only earns its label when there is a grid to snap TO — on a stopped or unanalysed
      // deck the build runs its nominal length, and saying SNAP there would be a lying indicator
      // (the same distinction GATE draws between ALIGN armed and actually LOCKed).
      const snap = dev.snapped ? (dev.hasGrid ? "  ·  SNAP" : "  ·  SNAP?") : "";
      const dirLabel = NOISE_DIRS[dev.dirIndex] ?? "UP";
      drawReadout(ctx2d, w, accent, {
        left: `${NOISE_TYPES[dev.typeIndex] ?? "?"}${dev.keyLocked ? " KEY" : ""}  ·  ${dirLabel}  ·  ${dev.rising ? `${bars} BAR${bars > 1 ? "S" : ""}${snap}` : "MANUAL"}`,
        mid: dragging.current ? `SWEEP ${dev.sweepHz < 1000 ? `${Math.round(dev.sweepHz)} Hz` : `${(dev.sweepHz / 1000).toFixed(1)} kHz`}  ·  RES ${Math.round(dev.getParam("res") * 100)}%` : "",
        midHot: dragging.current,
        right: `TONE ${Math.round(dev.getParam("tone") * 100)}%`,
      });

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      try {
        dev0.output.disconnect(an);
      } catch {
        /* ignore */
      }
    };
  }, [deck, slot, accent]);

  // XY pad: X = SWEEP, Y = RES (top = more resonance).
  // The readout strip at the top is a LABEL, not part of the pad — Y is measured from below it
  // (the same exclusion CRUSH and GATE use), so RES 100% is the top of the graph rather than a
  // point you can only reach by dragging onto the text.
  const apply = (e: React.PointerEvent) => {
    const r = mainRef.current?.getBoundingClientRect();
    if (!r) return;
    const vizH = Math.max(1, r.height - READOUT_H);
    set("sweep", clamp01((e.clientX - r.left) / r.width));
    set("res", clamp01(1 - (e.clientY - r.top - READOUT_H) / vizH));
  };
  // ── RESET, the gesture the rest of the rack already has (ValueCell, Knob, ReverbViz's grips,
  // EqCurve, CompViz): double-click or right-click puts this pad back to the device's OWN
  // considered resting values — paramDefault(), never an invented number. A control you can dial
  // but not undial is a control you try once.
  const resetPad = (e: React.MouseEvent) => {
    const dev = deck.fxDeviceAt(slot) as NoiseFx | undefined;
    if (!dev) return;
    const r = mainRef.current?.getBoundingClientRect();
    if (r && e.clientY - r.top < READOUT_H) return; // the strip is not a control
    for (const id of ["sweep", "res"]) set(id, dev.paramDefault(id));
  };
  const onDoubleClick = (e: React.MouseEvent) => resetPad(e);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    resetPad(e);
  };

  const onDown = (e: React.PointerEvent) => {
    const r = mainRef.current?.getBoundingClientRect();
    if (r && e.clientY - r.top < READOUT_H) return; // the strip is not a control
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
        <canvas ref={mainRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
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

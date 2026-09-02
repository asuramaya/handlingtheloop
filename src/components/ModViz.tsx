import { useEffect, useRef } from "react";
import { MOD_MODES, MOD_WAVES, BARBER_RAMPS, modLfoShape, barberRampShape, type Deck, type ModFx } from "@htl/audio";
import { drawCurvePanel, fitCanvas } from "./curveInset";
import { drawReadout, READOUT_H } from "./Readout";
import { usePulse } from "./usePulse";

// WYSIWYG for the modulation device: a live LOG-frequency spectrum of the output, so the
// comb peaks (chorus/flanger) and the notches (phaser) are visible — and they SWEEP with the
// LFO/envelope in real time. The standardized curve panel on the right shows the LFO
// WAVEFORM (BARBER: its RAMP shape). Doubles as an XY mod pad: drag X = RATE, Y = DEPTH. The
// shared Readout strip sits on its OWN canvas above the row (SAT's mounting pattern) — the main
// scope shares its row with the curve-preview panel, so it can't host the strip inside itself.
//
// ★ THE PICTURE IS THE ENGINE'S OWN SIGNALS, NOT A MAIN-THREAD GUESS. Every notch line and every
// dot below is placed from two taps the device keeps STABLE across rebuilds: `modSignal` (the
// tapped voice's live modulation — for CHORUS/FLANGER that is worklet voice 0's own LFO+env,
// which lives on the audio thread with its own phase and rate glide, not the mod bus) and
// `phaseSignal` (that voice's LFO phase, when the engine can report one). Other voices sit at
// their real offsets (k/N of a cycle) on the engine's own wave shape; BARBER's pairs at THEIR
// stagger on the real ramp curve, showing whichever line of each pair is currently open. Where
// no phase is reported (PHASER's native LFO), the phase is recovered from the signal's value and
// slope — still the signal, never `currentTime × rate`.

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
  const readoutRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const [wavePulse, pulseWave] = usePulse();

  useEffect(() => {
    const canvas = mainRef.current;
    const dev0 = deck.fxDeviceAt(slot) as ModFx | undefined;
    if (!canvas || !dev0) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const actx = dev0.output.context;
    const an = actx.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0.5;
    dev0.output.connect(an); // dim audio backdrop
    const bins = new Uint8Array(an.frequencyBinCount);
    const modAn = actx.createAnalyser(); // the REAL modulation signal (LFO + envelope)
    modAn.fftSize = 256;
    try {
      dev0.modSignal.connect(modAn);
    } catch {
      /* ignore */
    }
    const modBuf = new Float32Array(modAn.fftSize);
    const phaseAn = actx.createAnalyser(); // the tapped voice's LFO PHASE (worklet voices only)
    phaseAn.fftSize = 256;
    try {
      dev0.phaseSignal.connect(phaseAn);
    } catch {
      /* ignore */
    }
    const phaseBuf = new Float32Array(phaseAn.fftSize);
    const lfoAn = actx.createAnalyser(); // the native LFO alone (PHASER's phase reference)
    lfoAn.fftSize = 256;
    try {
      dev0.lfoSignal.connect(lfoAn);
    } catch {
      /* ignore */
    }
    const lfoBuf = new Float32Array(lfoAn.fftSize);

    let raf = 0;
    const draw = () => {
      // ★ RE-FETCHED EVERY FRAME, never captured once. A device swapped under a live rAF
      // loop (a chain edit, a preset load, a hot reload) leaves the old object still
      // answering getParam() with whatever it held when it was replaced — so the picture
      // simply freezes, with no error anywhere to explain it. Costs one map lookup a frame.
      const dev = (deck.fxDeviceAt(slot) as ModFx | undefined) ?? dev0;
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

      // THE STAR — the sweeping comb/notch positions from the REAL mod signal, bright glowing
      // vertical lines that move with the modulation (the audio is just context). Grouped by
      // voice/pair: the tapped one brightest, the others fading, so density reads as density.
      modAn.getFloatTimeDomainData(modBuf);
      phaseAn.getFloatTimeDomainData(phaseBuf);
      lfoAn.getFloatTimeDomainData(lfoBuf);
      const mode = Math.round(dev.getParam("mode"));
      const wave = Math.round(dev.getParam("wave"));
      const src = Math.round(dev.getParam("src"));
      const m = modBuf[modBuf.length - 1] || 0;
      let phase: number | undefined;
      if (dev.hasPhaseSignal) phase = phaseBuf[phaseBuf.length - 1];
      else if (mode === 2 && src !== 1) {
        // native LFO, no phase report: recover it from the PURE LFO tap's value + slope (never
        // from modSignal — in ENV/BOTH that carries the envelope share too), PER SHAPE, so the
        // dot lands ON the drawn curve — SINE: atan2 of (value, slope/2πf), exact; TRI: the
        // rising leg is p=(v+1)/4, the falling leg p=(3−v)/4, exact; SQUARE: the value only says
        // which plateau, so the dot sits at that plateau's centre.
        const k = 8;
        const l = lfoBuf[lfoBuf.length - 1] || 0;
        const prev = lfoBuf[lfoBuf.length - 1 - k] ?? l;
        const rising = l >= prev;
        const v = Math.max(-1, Math.min(1, l));
        if (wave === 1) phase = rising ? (v + 1) / 4 : (3 - v) / 4;
        else if (wave === 2) phase = v >= 0 ? 0.25 : 0.75;
        else {
          const dl = ((l - prev) / k) * actx.sampleRate; // per second
          const c = dl / (2 * Math.PI * Math.max(0.01, dev.rateHz));
          phase = Math.atan2(l, c) / (2 * Math.PI);
        }
        phase -= Math.floor(phase);
      }
      const targets = dev.modTargets(m, phase);
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = 7;
      const seen: Record<number, number> = {};
      for (const t of targets) {
        const j = seen[t.group] ?? 0;
        seen[t.group] = j + 1;
        const x = fx(t.hz, w);
        const a = Math.max(14, Math.round((t.group === 0 ? 95 : 55) - j * 6));
        ctx2d.strokeStyle = `color-mix(in srgb, ${accent} ${a}%, transparent)`;
        ctx2d.lineWidth = t.group === 0 ? (j === 0 ? 2.6 : 1.4) : 1;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
      }
      ctx2d.shadowBlur = 0;

      // ★ THE PAD'S OWN ANSWER TO A PRESS. The whole scope is an XY pad (X=RATE, Y=DEPTH) and it
      // used to swallow a drag without a mark on it — the numbers moved in the row below, which is
      // not where your eyes are. A crosshair puck at (rate, depth) while you hold it.
      // ONLY while dragging, deliberately: this canvas's x-axis is LOG FREQUENCY for the spectrum
      // behind it, and RATE is not a frequency — a puck parked there at rest would read as "the
      // modulation is at 900 Hz", which is a lie. It's a live cursor, so it's honest only while
      // your finger is the thing putting it there.
      if (dragging.current) {
        const px = Math.max(9, Math.min(w - 9, clamp01(dev.getParam("rate")) * w));
        const py = Math.max(9, Math.min(h - 9, (1 - clamp01(dev.getParam("depth"))) * h));
        ctx2d.strokeStyle = `color-mix(in srgb, ${accent} 95%, transparent)`;
        ctx2d.lineWidth = 2;
        ctx2d.shadowColor = accent;
        ctx2d.shadowBlur = 10;
        ctx2d.beginPath();
        ctx2d.arc(px, py, 6.5, 0, 2 * Math.PI);
        ctx2d.stroke();
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          ctx2d.moveTo(px + dx * 9, py + dy * 9);
          ctx2d.lineTo(px + dx * 13, py + dy * 13);
        }
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      }

      // The waveform panel: the LFO shape (BARBER: the RAMP shape) + one live dot PER VOICE / PAIR
      // riding it at its real phase — the tapped one bright, its siblings dimmer. The tapped dot's
      // height is the tapped signal itself (m), so an envelope push visibly lifts it OFF the wave.
      const cc = curveRef.current;
      if (cc) {
        const f = fitCanvas(cc);
        if (f.ctx) {
          const pad = 5;
          const iw = f.w - pad * 2;
          const ih = f.h - pad * 2;
          const dot = (x01: number, y: number, bright: boolean, unipolar: boolean) => {
            const dx = pad + (x01 - Math.floor(x01)) * iw;
            const dy = unipolar ? pad + ih - clamp01(y) * (ih - 1) - 1 : pad + ih / 2 - Math.max(-1, Math.min(1, y)) * (ih / 2) * 0.92;
            f.ctx!.fillStyle = bright ? accent : `color-mix(in srgb, ${accent} 45%, transparent)`;
            f.ctx!.shadowColor = accent;
            f.ctx!.shadowBlur = bright ? 7 : 3;
            f.ctx!.beginPath();
            f.ctx!.arc(dx, dy, bright ? 3 : 2.2, 0, 2 * Math.PI);
            f.ctx!.fill();
            f.ctx!.shadowBlur = 0;
          };
          if (mode === 3) {
            const shape = (u: number) => barberRampShape(wave, u);
            drawCurvePanel(f.ctx, f.w, f.h, accent, shape, { bipolar: false });
            // line A's saw m (−1..1) → each pair's open line at its stagger, folded to (−0.5, 0.5],
            // → ramp position u (held past the guard, same as the engine)
            const pairs = dev.pairs;
            for (let p = pairs - 1; p >= 0; p--) {
              let x = m + (2 * p) / pairs;
              x = x - 2 * Math.floor((x + 1) / 2);
              if (x > 0.5) x -= 1;
              else if (x <= -0.5) x += 1;
              const u = clamp01((x / 0.8 + 1) / 2);
              dot(u, shape(u), p === 0, true);
            }
          } else {
            // ★ ENV/BOTH extend the panel's vertical range. The dot's height is the TOTAL modulation
            // m = LFO + envelope, and the envelope share (rectified program level ×4) is unipolar
            // and can be several times the LFO's ±1 — on a ±1 panel it pinned the dot to the top
            // and told you nothing. In LFO mode the panel is ±1 as before; in ENV/BOTH it spans
            // −1‥+3, the LFO curve is drawn into that same range (so dots still ride it exactly)
            // and the envelope visibly LIFTS every dot off the wave by the same amount.
            const top = src === 0 ? 1 : 3;
            const toPanel = (v: number) => (2 * (v + 1)) / (top + 1) - 1; // −1‥top → −1‥1
            const shape = (t: number) => modLfoShape(wave, t);
            const lfoOn = src !== 1;
            if (!lfoOn) f.ctx.globalAlpha = 0.35; // ENV only: the LFO shape is inert here
            drawCurvePanel(f.ctx, f.w, f.h, accent, (t) => toPanel(lfoOn ? shape(t) : 0), { bipolar: true });
            f.ctx.globalAlpha = 1;
            const ph = phase ?? 0;
            if (mode < 2 && lfoOn) {
              const N = Math.max(2, Math.round(dev.stages));
              const env = m - shape(ph); // the share every voice gets alike
              for (let k = N - 1; k >= 1; k--) dot(ph + k / N, toPanel(shape(ph + k / N) + env), false, false);
            }
            dot(lfoOn ? ph : 0.5, toPanel(m), true, false);
          }
          // ★ THE INSET IS A CYCLER, SO IT OWES YOU ITS DEPTH — the same law .cyc-pips enforces on
          // the MODE chip. Clicking here steps SINE → TRI → SQUARE (BARBER: EASE → LINEAR → SNAP),
          // and until now the ONLY hint was the title attribute: a shape with no pips reads as a
          // read-only preview (which is exactly what .fx-curve is on SAT/COMP). Three dots in the
          // bottom margin, current one lit — it says "there are two more behind this" at rest, and
          // it's what visibly steps when you click.
          const n = (mode === 3 ? BARBER_RAMPS : MOD_WAVES).length;
          const py = f.h - 3.5;
          for (let i = 0; i < n; i++) {
            const px = f.w - pad - (n - 1 - i) * 5;
            const on = i === wave;
            f.ctx.fillStyle = on ? accent : `color-mix(in srgb, ${accent} 30%, transparent)`;
            f.ctx.shadowColor = accent;
            f.ctx.shadowBlur = on ? 4 : 0;
            f.ctx.beginPath();
            f.ctx.arc(px, py, 1.6, 0, 2 * Math.PI);
            f.ctx.fill();
            f.ctx.shadowBlur = 0;
          }
        }
      }

      // The readout — a separate full-width canvas above the viz row (the main scope sits beside
      // the curve-preview panel, same as SAT, so it can't host the strip itself). LEFT: what the
      // device IS (mode · wave shape). MIDDLE: what you're TOUCHING (the XY pad's live rate/depth
      // while dragging). RIGHT: its tone (TONE shelf · FEEDBACK).
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
        const sync = dev.getParam("sync") >= 0.5;
        const rateLabel = sync ? dev.divLabel : `${dev.rateHz.toFixed(2)} Hz`;
        const depthPct = Math.round(clamp01(dev.getParam("depth")) * 100);
        const tonePct = Math.round((clamp01(dev.getParam("tone")) - 0.5) * 200);
        const fbPct = Math.round(clamp01(dev.getParam("feedback")) * 100);
        const density = Math.round(dev.stages);
        const densityLabel = mode === 0 ? `${density} VOICES` : mode === 1 ? `${density} TAPS` : mode === 2 ? `${density} STAGES` : `${dev.pairs} PAIRS`;
        const thru = mode === 1 && dev.getParam("thru") >= 0.5 ? "  ·  THRU" : "";
        drawReadout(rctx, rw, accent, {
          left: `${MOD_MODES[mode] ?? "?"}  ·  ${(mode === 3 ? BARBER_RAMPS[wave] : MOD_WAVES[wave]) ?? "?"}${thru}`,
          right: `${densityLabel}  ·  TONE ${tonePct >= 0 ? "+" : ""}${tonePct}  ·  FB ${fbPct}%`,
          mid: dragging.current ? `RATE ${rateLabel}  ·  DEPTH ${depthPct}%` : "",
          midHot: dragging.current,
        });
      }

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
      try {
        dev0.modSignal.disconnect(modAn);
      } catch {
        /* ignore */
      }
      try {
        dev0.phaseSignal.disconnect(phaseAn);
      } catch {
        /* ignore */
      }
      try {
        dev0.lfoSignal.disconnect(lfoAn);
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
  // ── RESET, the gesture the rest of the rack already has (ValueCell, Knob, ReverbViz's grips,
  // EqCurve, CompViz): double-click or right-click puts this pad back to the device's OWN
  // considered resting values — paramDefault(), never an invented number. A control you can dial
  // but not undial is a control you try once.
  const resetPad = () => {
    const dev = deck.fxDeviceAt(slot) as ModFx | undefined;
    if (!dev) return;
    for (const id of ["rate", "depth"]) set(id, dev.paramDefault(id));
  };
  const onDoubleClick = () => resetPad();
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    resetPad();
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

  // WAVE lives here now, not as its own button row — the curve inset already DRAWS the shape
  // those buttons picked, so clicking it cycles SINE → TRI → SQUARE (BARBER: EASE → LINEAR → SNAP).
  const cycleWave = () => {
    const dev = deck.fxDeviceAt(slot) as ModFx | undefined;
    if (!dev) return;
    const w = Math.round(dev.getParam("wave"));
    set("wave", (w + 1) % MOD_WAVES.length);
    pulseWave(); // SINE→TRI is a small change to a small curve — flash the panel you actually hit
  };

  return (
    <div className="sat-status">
      <canvas ref={readoutRef} className="sat-readout" style={{ height: READOUT_H }} />
      <div className="fx-viz-row">
        <div className="sat-viz">
          <canvas ref={mainRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
        </div>
        <div className={`fx-curve mod-wave ${wavePulse}`} onClick={cycleWave} title="Click to cycle the LFO waveform (BARBER: the ramp shape)">
          <canvas ref={curveRef} className="fx-curve-canvas" />
        </div>
      </div>
    </div>
  );
}

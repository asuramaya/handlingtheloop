import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useEmit } from "../App/spine";
import type { Deck } from "@htl/audio";
import { EQ_MIN_DB, EQ_MAX_DB, EQ_OUT_DB, EQ_HP, EQ_LP, EQ_Q_MIN, EQ_Q_MAX, EQ_SHAPE_TYPES, EQ_SHAPE_LABELS, EQ_SHAPE_DEFAULT, qToFrac } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { drawReadout, READOUT_H } from "./Readout";
import { clamp } from "../util/math";
import { fmtHz, fmtDb } from "../util/format";

// A pro parametric EQ surface — a simplified FabFilter Pro-Q built on the deck's real
// biquad chain. Up to five nodes you drag in 2D over a live spectrum:
//   HP-cut · LOW shelf · MID bell · HIGH shelf · LP-cut
// Shelves/bell: drag X = frequency, Y = gain (MID wheel/drag-Y peers = bell width).
// Cut nodes: drag X = cutoff, Y = resonance (Q), wheel = Q. The curve is read straight
// off the filters (getFrequencyResponse), so it IS the filter. Extras: the OTHER
// deck's post spectrum overlaid faintly (clash view), always-on peak-hold, harmonic
// guides from the detected key, a cursor freq/dB readout, and a BYPASS / RESET / COPY
// toolbar UNDER the curve.
//
// Rendering is imperative (canvas + rAF, like the waveform) so dragging and the
// animating spectrum never churn React.
//
// The top strip is the SHARED Readout (Delay/Reverb/Sat/Crush/Gate/Mod all wear it): LEFT = what
// the device is (the selected band and its shape), MIDDLE = what you're touching, RIGHT = its
// secondary info (output trim / bypass). It replaces the old floating cursor tooltip, which was
// the same two numbers in a per-device pill that hovered over the spectrum — one law for FX status
// text, in the same place on every panel, instead of one more thing to hunt for.
// The graph is drawn BELOW it (the canvas is translated by READOUT_H and every y measured against
// the remaining height), so pointer maths and the absolutely-positioned handles subtract it back.

const F_MIN = 20;
const F_MAX = 20000;
const F_SPAN = Math.log10(F_MAX / F_MIN);
// Symmetric window so 0 dB sits dead centre (flat curve = line through the middle).
const DB_TOP = 12;
const DB_BOT = -12;
const Q_TOP_PAD = 0.14; // fraction of height reserved above centre for max resonance
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

type Vert = "gain" | "q";
interface NodeDef {
  key: "hp" | "low" | "mid" | "high" | "lp";
  label: string;
  color: string;
  vert: Vert;
  fMin: number;
  fMax: number;
  fDefault: number;
  getFreq: (d: Deck) => number;
  setFreq: (d: Deck, hz: number) => void;
  getGain: (d: Deck) => number;
  setGain: (d: Deck, db: number) => void;
  getQ: (d: Deck) => number;
  setQ: (d: Deck, q: number) => void;
  // SHAPE (LOW/MID/HIGH only): the band's filter character (bell / lo-shelf / hi-shelf).
  // Q is live only in bell mode, so the Q cell greys out otherwise.
  getShape?: (d: Deck) => number;
  setShape?: (d: Deck, i: number) => void;
  sDefault?: number;
  // room-sync param ids
  fParam: "eqLowFreq" | "eqMidFreq" | "eqHighFreq" | "eqHpFreq" | "eqLpFreq";
  gParam?: "eqLow" | "eqMid" | "eqHigh";
  qParam?: "eqMidQ" | "eqLowQ" | "eqHighQ" | "eqHpQ" | "eqLpQ";
  sParam?: "eqLowShape" | "eqMidShape" | "eqHighShape";
}

const NODES: NodeDef[] = [
  { key: "hp", label: "HP", color: "#9aa7ff", vert: "q", fMin: EQ_HP.min, fMax: EQ_HP.max, fDefault: EQ_HP.freq, getFreq: (d) => d.eqHpFreq, setFreq: (d, v) => d.setEqHpFreq(v), getGain: () => 0, setGain: () => {}, getQ: (d) => d.eqHpQ, setQ: (d, v) => d.setEqHpQ(v), fParam: "eqHpFreq", qParam: "eqHpQ" },
  { key: "low", label: "LOW", color: "#ff6b9d", vert: "gain", fMin: 40, fMax: 500, fDefault: 200, getFreq: (d) => d.eqLowFreq, setFreq: (d, v) => d.setEqLowFreq(v), getGain: (d) => d.eqLow, setGain: (d, v) => d.setEqLow(v), getQ: (d) => d.eqLowQ, setQ: (d, v) => d.setEqLowQ(v), getShape: (d) => d.eqLowShape, setShape: (d, v) => d.setEqLowShape(v), sDefault: EQ_SHAPE_DEFAULT.low, fParam: "eqLowFreq", gParam: "eqLow", qParam: "eqLowQ", sParam: "eqLowShape" },
  { key: "mid", label: "MID", color: "#ffd250", vert: "gain", fMin: 200, fMax: 6000, fDefault: 1000, getFreq: (d) => d.eqMidFreq, setFreq: (d, v) => d.setEqMidFreq(v), getGain: (d) => d.eqMid, setGain: (d, v) => d.setEqMid(v), getQ: (d) => d.eqMidQ, setQ: (d, v) => d.setEqMidQ(v), getShape: (d) => d.eqMidShape, setShape: (d, v) => d.setEqMidShape(v), sDefault: EQ_SHAPE_DEFAULT.mid, fParam: "eqMidFreq", gParam: "eqMid", qParam: "eqMidQ", sParam: "eqMidShape" },
  { key: "high", label: "HI", color: "#36c2ff", vert: "gain", fMin: 1500, fMax: 16000, fDefault: 3200, getFreq: (d) => d.eqHighFreq, setFreq: (d, v) => d.setEqHighFreq(v), getGain: (d) => d.eqHigh, setGain: (d, v) => d.setEqHigh(v), getQ: (d) => d.eqHighQ, setQ: (d, v) => d.setEqHighQ(v), getShape: (d) => d.eqHighShape, setShape: (d, v) => d.setEqHighShape(v), sDefault: EQ_SHAPE_DEFAULT.high, fParam: "eqHighFreq", gParam: "eqHigh", qParam: "eqHighQ", sParam: "eqHighShape" },
  { key: "lp", label: "LP", color: "#7dffd6", vert: "q", fMin: EQ_LP.min, fMax: EQ_LP.max, fDefault: EQ_LP.freq, getFreq: (d) => d.eqLpFreq, setFreq: (d, v) => d.setEqLpFreq(v), getGain: () => 0, setGain: () => {}, getQ: (d) => d.eqLpQ, setQ: (d, v) => d.setEqLpQ(v), fParam: "eqLpFreq", qParam: "eqLpQ" },
];

// Subrow cell formatter (the Pro-Q-style numeric companion under the curve).
const fmtQ = (q: number) => q.toFixed(1);
const xFromFreq = (hz: number, w: number) => (Math.log10(hz / F_MIN) / F_SPAN) * w;
const freqFromX = (x: number, w: number) => F_MIN * Math.pow(10, (x / w) * F_SPAN);
const yFromDb = (db: number, h: number) => ((DB_TOP - db) / (DB_TOP - DB_BOT)) * h;
const dbFromY = (y: number, h: number) => DB_TOP - (y / h) * (DB_TOP - DB_BOT);
// ★ THE CUT NODES HANG ON THE CURVE, and resonance is the whole height above it.
//
// They used to sit at h/2 on an abstract Q axis — which is NOT where the curve is (0 dB draws at
// 12/24 of the height, not the middle), so the HP/LP handles floated below the line they belong
// to. Worse, their resting resonance IS their minimum: flat. So dragging DOWN did nothing at all —
// half the vertical axis was dead, and the first instinct on grabbing a handle is to pull it
// somewhere. It read as "this one only goes sideways".
//
// Resonance is genuinely UNIPOLAR — there is no "less than flat" — so the honest design is not to
// invent a downward meaning. It's to stop the handle pretending to be a 2D one. A cut node now
// rides a visible RESONANCE RAIL: a track from the flat line up to full resonance, drawn whenever
// you're near it. The handle sits at the bottom of its own rail, which is exactly what "flat"
// means, and the rail says plainly which way there is to go. (It also hangs on the OUTPUT baseline
// rather than a hardcoded h/2, so it stays on the curve when the trim moves it.)
const qNorm = (q: number) => qToFrac(q, EQ_Q_MIN, EQ_Q_MAX);
const yFromQ = (q: number, h: number, baseY: number) => baseY - clamp(qNorm(q), 0, 1) * (baseY - h * Q_TOP_PAD);
const qFromY = (y: number, h: number, baseY: number) => {
  const n = clamp((baseY - y) / Math.max(1, baseY - h * Q_TOP_PAD), 0, 1);
  return EQ_Q_MIN * Math.pow(EQ_Q_MAX / EQ_Q_MIN, n);
};

interface EqCurveProps {
  deck: Deck;
  id: "A" | "B";
  accent: string;
  otherDeck: Deck;
  otherAccent: string;
}

export function EqCurve({ deck, id, accent, otherDeck, otherAccent }: EqCurveProps) {
  const emit = useEmit();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const outRef = useRef<HTMLDivElement>(null); // the draggable output baseline (the graph's zero)
  const outPillRef = useRef<HTMLSpanElement>(null);
  const handleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // h = the element box; vh = the GRAPH's height (the readout strip owns the top READOUT_H px).
  const size = useRef({ w: 0, h: 0, vh: 0, dpr: 1 });
  // What the pointer is over, for the readout's middle zone when nothing is being dragged.
  const hover = useRef<{ hz: number; db: number } | null>(null);
  const freqs = useRef<Float32Array>(new Float32Array(0));
  const magBuf = useRef<Float32Array>(new Float32Array(0));
  const specBuf = useRef<Uint8Array>(new Uint8Array(0));
  const otherSpec = useRef<Uint8Array>(new Uint8Array(0));
  const peakBuf = useRef<Uint8Array>(new Uint8Array(0));
  const dirty = useRef(true);
  const eqSig = useRef(0); // cheap signature of the EQ params → redraw when it changes (e.g. a MIDI knob while paused)
  // active gesture on a node: a drag (sweep).
  const drag = useRef<{ i: number } | null>(null);
  const outDrag = useRef(false); // dragging the output baseline
  const [sel, setSel] = useState(2); // band whose numeric subrow is shown (default MID)
  // The rAF draw loop is created once (deps: deck/accent), so it would close over the FIRST `sel`
  // forever — the resonance rail drew for whatever band happened to be selected at mount. Mirror it
  // in a ref: the loop is imperative, so it must read live values, not render-time snapshots.
  const selRef = useRef(sel);
  selRef.current = sel;
  const [, bump] = useState(0);

  // The canvas repaints itself in its own rAF loop, but the numeric cells are REACT — so a drag
  // that only marked the canvas dirty left FREQ/GAIN/Q frozen until pointer-up, and the numbers
  // visibly lagged the node you were holding. Re-render them live, but COALESCE to one render per
  // frame: a pointermove can fire several times per frame and each would otherwise be its own
  // React pass.
  const bumpPending = useRef(0);
  const bumpNow = () => {
    if (bumpPending.current) return;
    bumpPending.current = requestAnimationFrame(() => {
      bumpPending.current = 0;
      bump((x) => x + 1);
    });
  };
  useEffect(() => () => { if (bumpPending.current) cancelAnimationFrame(bumpPending.current); }, []);

  // (Re)size canvas + per-pixel buffers to the element box.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(wrap.clientWidth));
      const h = Math.max(1, Math.round(wrap.clientHeight));
      size.current = { w, h, vh: Math.max(1, h - READOUT_H), dpr };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const f = new Float32Array(w);
      for (let i = 0; i < w; i++) f[i] = freqFromX(i, w);
      freqs.current = f;
      magBuf.current = new Float32Array(w);
      specBuf.current = new Uint8Array(deck.spectrumBins);
      otherSpec.current = new Uint8Array(otherDeck.spectrumBins);
      peakBuf.current = new Uint8Array(deck.spectrumBins);
      dirty.current = true;
      bump((n) => n + 1);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [deck, otherDeck]);

  // SHIFT + wheel over the curve reshapes the nearest band's Q (bell width / cut
  // resonance) live. Plain wheel is left alone so it still scrolls. Native
  // non-passive listener so preventDefault works under the gesture. Note: many
  // platforms turn a Shift-held vertical wheel into horizontal, so read deltaX too.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return; // plain wheel scrolls as usual
      const { w } = size.current;
      if (w === 0) return;
      const delta = e.deltaY || e.deltaX;
      if (!delta) return;
      const rect = wrap.getBoundingClientRect();
      const hz = freqFromX(clamp(e.clientX - rect.left, 0, w), w);
      let best: NodeDef | null = null;
      let bestD = Infinity;
      for (const n of NODES) {
        if (!n.qParam) continue;
        const d = Math.abs(Math.log(n.getFreq(deck)) - Math.log(hz));
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (!best || !best.qParam) return;
      e.preventDefault();
      const q = clamp(best.getQ(deck) * (delta < 0 ? 1.12 : 0.89), EQ_Q_MIN, EQ_Q_MAX);
      best.setQ(deck, q);
      emit({ kind: "control", deck: id, param: best.qParam, value: q });
      dirty.current = true;
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [deck, id, emit]);

  // Imperative draw loop.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // While paused the spectrum is static, so also redraw when the EQ params change
      // (a MIDI knob / sync-copy moves the curve with no pointer event or playback).
      const sig =
        deck.eqLow + deck.eqMid * 7 + deck.eqHigh * 13 + deck.eqLowFreq + deck.eqMidFreq * 3 + deck.eqHighFreq * 5 + deck.eqMidQ * 17 + deck.eqHpFreq + deck.eqLpFreq + deck.eqOut * 23 + (deck.eqBypassed ? 1e6 : 0);
      if (deck.playing || otherDeck.playing || dirty.current || sig !== eqSig.current) {
        draw();
        dirty.current = false;
        eqSig.current = sig;
      }
      raf = requestAnimationFrame(tick);
    };
    const specToY = (v: number, h: number) => h - v * h * 0.92;
    const drawSpectrum = (ctx: CanvasRenderingContext2D, buf: Uint8Array, color: string, w: number, h: number, fill: boolean, alpha: number) => {
      const bins = buf.length;
      const nyq = deck.sampleRate / 2;
      ctx.beginPath();
      if (fill) ctx.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        const bin = clamp(Math.round((freqs.current[x] / nyq) * (bins - 1)), 0, bins - 1);
        const y = specToY(buf[bin] / 255, h);
        if (x === 0 && !fill) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (fill) {
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    const draw = () => {
      const canvas = canvasRef.current;
      // ★ `h` below IS the graph height (vh) — everything in this function draws inside the
      // translated frame, so the readout strip can never be drawn over.
      const { w, h: boxH, vh: h, dpr } = size.current;
      if (!canvas || w === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, boxH);
      ctx.save();
      ctx.translate(0, READOUT_H);

      // grid
      ctx.lineWidth = 1;
      for (const hz of GRID_HZ) {
        const x = Math.round(xFromFreq(hz, w)) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (const db of [9, 6, 3, 0, -3, -6, -9]) {
        const y = Math.round(yFromDb(db, h)) + 0.5;
        ctx.strokeStyle = db === 0 ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.05)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // harmonic guides from the detected key (tonic + octaves)
      const key = deck.effectiveKey;
      if (key) {
        const base = 16.3516 * Math.pow(2, key.tonic / 12); // C0-relative tonic
        ctx.strokeStyle = `color-mix(in srgb, ${accent} 40%, transparent)`;
        for (let oct = 1; oct <= 9; oct++) {
          const f = base * Math.pow(2, oct);
          if (f < F_MIN || f > F_MAX) continue;
          const x = Math.round(xFromFreq(f, w)) + 0.5;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // clash view: the other deck's post spectrum, faint, in its accent
      otherDeck.spectrum(otherSpec.current, "post");
      drawSpectrum(ctx, otherSpec.current, otherAccent, w, h, false, 0.4);

      // this deck's post spectrum, filled
      deck.spectrum(specBuf.current, "post");
      drawSpectrum(ctx, specBuf.current, accent, w, h, true, 0.14);

      // peak-hold overlay (always on)
      const pk = peakBuf.current;
      for (let i = 0; i < pk.length; i++) pk[i] = Math.max(specBuf.current[i], pk[i] > 2 ? pk[i] - 2 : 0);
      drawSpectrum(ctx, pk, accent, w, h, false, 0.5);

      // The real combined EQ response curve, filled to the OUTPUT BASELINE — not to 0 dB.
      // `eqMagnitude` already draws the curve sitting on the output trim, so the trim IS where
      // zero is; filling to it means the shaded area reads as the EQ's SHAPING, independent of
      // how loud the whole curve was pushed. (Fill to a hard 0 dB and a flat curve trimmed +6
      // would show a solid block of "boost" that isn't shaping anything.)
      deck.eqMagnitude(freqs.current, magBuf.current);
      const y0 = yFromDb(deck.eqOut, h);
      const curveY = (x: number) => clamp(yFromDb(magBuf.current[x], h), -6, h + 6);
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y = curveY(x);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineTo(w - 1, y0);
      ctx.lineTo(0, y0);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y = curveY(x);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = deck.eqBypassed ? "rgba(255,255,255,0.25)" : accent;
      ctx.lineWidth = 2;
      ctx.shadowColor = accent;
      ctx.shadowBlur = deck.eqBypassed ? 0 : 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // THE RESONANCE RAIL — the cut nodes' one honest axis, made visible. Only drawn for the cut
      // you're actually working (selected or being dragged), so it never clutters the curve.
      for (let i = 0; i < NODES.length; i++) {
        const n = NODES[i];
        if (n.vert !== "q") continue;
        const live = drag.current?.i === i || selRef.current === i;
        if (!live) continue;
        const rx = clamp(xFromFreq(n.getFreq(deck), w), 11, w - 11);
        const railTop = h * Q_TOP_PAD;
        const railBot = yFromDb(deck.eqOut, h);
        ctx.strokeStyle = n.color;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(rx) + 0.5, railTop);
        ctx.lineTo(Math.round(rx) + 0.5, railBot);
        ctx.stroke();
        ctx.setLineDash([]);
        // the rail's ceiling, so "how far up can this go" is answerable at a glance
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(rx) - 4.5, railTop + 0.5);
        ctx.lineTo(Math.round(rx) + 4.5, railTop + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.restore();

      // The readout. LEFT: the selected band and what it IS (its shape) — the row of numeric
      // cells below belongs to that band, and this is what says so. MIDDLE: what you're touching
      // (hot while dragging a node or the baseline; the cursor's freq/level, dim, while merely
      // hovering). RIGHT: the trim, and BYPASS when the whole EQ is out of circuit.
      const n = NODES[clamp(selRef.current, 0, NODES.length - 1)];
      const shapeLabel = n.getShape ? EQ_SHAPE_LABELS[clamp(Math.round(n.getShape(deck)), 0, EQ_SHAPE_LABELS.length - 1)] : "CUT";
      const g = drag.current;
      let mid = "";
      let midHot = true;
      if (outDrag.current) {
        mid = `OUT ${fmtDb(deck.eqOut)} dB`;
      } else if (g) {
        const d = NODES[g.i];
        mid = `${d.label}  ·  ${fmtHz(d.getFreq(deck))} Hz  ·  ${d.vert === "gain" ? `${fmtDb(d.getGain(deck))} dB` : `Q ${d.getQ(deck).toFixed(1)}`}`;
      } else if (hover.current) {
        mid = `${fmtHz(hover.current.hz)} Hz  ·  ${fmtDb(hover.current.db)} dB`;
        midHot = false;
      }
      drawReadout(ctx, w, accent, {
        left: `${n.label}  ·  ${shapeLabel}`,
        mid,
        midHot,
        right: `${deck.eqBypassed ? "BYPASS  ·  " : ""}OUT ${fmtDb(deck.eqOut)} dB`,
      });

      // The output baseline rides with the trim (see y0 above) — it IS the graph's zero.
      const outEl = outRef.current;
      if (outEl) {
        outEl.style.top = `${READOUT_H + clamp(y0, 0, h)}px`;
        const pill = outPillRef.current;
        const o = deck.eqOut;
        if (pill) pill.textContent = `${o > 0 ? "+" : ""}${o.toFixed(1)}`;
        outEl.classList.toggle("trimmed", Math.abs(o) > 0.05);
      }

      // reposition node dots to match the live filter
      for (let i = 0; i < NODES.length; i++) {
        const el = handleRefs.current[i];
        if (!el) continue;
        const n = NODES[i];
        // Keep the dot (and its label) a hair inside the box so the edge HP/LP nodes
        // parked at 20 Hz / 20 kHz don't clip off-screen.
        el.style.left = `${clamp(xFromFreq(n.getFreq(deck), w), 11, w - 11)}px`;
        // A gain node rides the OUTPUT BASELINE, not absolute 0 dB — the curve does (it's drawn
        // offset by the trim), and a node that didn't would float off the curve it's meant to be
        // sitting on the moment you moved the baseline. The cut nodes (HP/LP) are on the Q axis,
        // not the dB axis, so the trim doesn't move them.
        el.style.top = `${READOUT_H + (n.vert === "gain" ? yFromDb(n.getGain(deck) + deck.eqOut, h) : yFromQ(n.getQ(deck), h, yFromDb(deck.eqOut, h)))}px`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deck, otherDeck, accent, otherAccent]);

  useEffect(() => {
    dirty.current = true;
  }, [accent]);

  // --- node gestures ---
  const applyDrag = (n: NodeDef, clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const { w, vh: h } = size.current;
    const y = clientY - rect.top - READOUT_H; // the graph starts below the readout strip
    const hz = clamp(freqFromX(clientX - rect.left, w), n.fMin, n.fMax);
    n.setFreq(deck, hz);
    emit({ kind: "control", deck: id, param: n.fParam, value: n.getFreq(deck) });
    if (n.vert === "gain" && n.gParam) {
      // The node is drawn relative to the output baseline, so read its drag back relative to it
      // too — otherwise, with the trim off zero, the dot jumps out from under the cursor.
      const db = clamp(dbFromY(y, h) - deck.eqOut, DB_BOT, EQ_MAX_DB);
      n.setGain(deck, db);
      emit({ kind: "control", deck: id, param: n.gParam, value: n.getGain(deck) });
    } else if (n.vert === "q" && n.qParam) {
      const q = clamp(qFromY(y, h, yFromDb(deck.eqOut, h)), EQ_Q_MIN, EQ_Q_MAX);
      n.setQ(deck, q);
      emit({ kind: "control", deck: id, param: n.qParam, value: q });
    }
    dirty.current = true;
    bumpNow(); // the cells track the node you're holding, not the mouse you released
  };

  // OUTPUT TRIM, as the graph's baseline. Drag the zero line and the whole curve rides with
  // it — which is what the trim literally does (Eq3.magnitude offsets the response by it). It
  // was a number cell in the band row, where it didn't belong: it isn't a property of a band.
  const applyOutDrag = (clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { vh: h } = size.current;
    const db = clamp(dbFromY(clientY - wrap.getBoundingClientRect().top - READOUT_H, h), -EQ_OUT_DB, EQ_OUT_DB);
    deck.setEqOut(db);
    emit({ kind: "control", deck: id, param: "eqOut", value: db });
    dirty.current = true;
    // No bump: nothing React-rendered reads eqOut. The badge text and the line's position are
    // both written imperatively in the rAF tick, so an OUT drag is already live.
  };
  const resetOut = () => {
    deck.setEqOut(0);
    emit({ kind: "control", deck: id, param: "eqOut", value: 0 });
    dirty.current = true;
    bump((x) => x + 1);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (outDrag.current) {
      applyOutDrag(e.clientY);
      return;
    }
    // cursor readout (when not dragging a node) → the readout's MIDDLE zone
    const wrap = wrapRef.current;
    if (wrap && !drag.current) {
      const rect = wrap.getBoundingClientRect();
      const { w } = size.current;
      const x = e.clientX - rect.left;
      if (x >= 0 && x <= w) {
        const idx = clamp(Math.round(x), 0, w - 1);
        hover.current = { hz: freqFromX(x, w), db: magBuf.current[idx] ?? 0 };
        dirty.current = true; // a paused deck redraws nothing on its own
      }
    }
    const g = drag.current;
    if (!g) return;
    applyDrag(NODES[g.i], e.clientX, e.clientY);
  };

  const startDrag = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { i };
    setSel(i); // touching a node selects its band for the numeric subrow
  };
  const endDrag = (e: React.PointerEvent) => {
    if (outDrag.current) {
      outDrag.current = false;
      bump((x) => x + 1);
    }
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    bump((x) => x + 1);
  };
  const hideReadout = () => {
    if (drag.current) return;
    hover.current = null;
    dirty.current = true;
  };

  const resetNode = (n: NodeDef) => {
    n.setFreq(deck, n.fDefault);
    emit({ kind: "control", deck: id, param: n.fParam, value: n.getFreq(deck) });
    if (n.vert === "gain" && n.gParam) {
      n.setGain(deck, 0);
      emit({ kind: "control", deck: id, param: n.gParam, value: 0 });
      if (n.qParam) {
        n.setQ(deck, 0.9);
        emit({ kind: "control", deck: id, param: n.qParam, value: 0.9 });
      }
    } else if (n.qParam) {
      const dq = n.key === "hp" ? EQ_HP.q : EQ_LP.q;
      n.setQ(deck, dq);
      emit({ kind: "control", deck: id, param: n.qParam, value: dq });
    }
    dirty.current = true;
    bump((x) => x + 1);
  };

  return (
    <div className={`eq-pro ${deck.eqBypassed ? "bypassed" : ""}`}>
      <div
        className="eq-curve"
        ref={wrapRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={hideReadout}
      >
        <canvas ref={canvasRef} className="eq-curve-canvas" />
        {/* OUTPUT TRIM — the graph's zero line, grabbable. Drag it and the curve rides with it.
            Sits UNDER the node buttons in the DOM so a node always wins the pointer where they
            cross. Right-click / double-click parks it back at 0. */}
        <div
          ref={outRef}
          className="eq-out"
          title="Output trim — drag the baseline (double-click to reset)"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            outDrag.current = true;
            applyOutDrag(e.clientY);
          }}
          onDoubleClick={resetOut}
          onContextMenu={(e) => {
            e.preventDefault();
            resetOut();
          }}
        >
          {/* Contextual: silent at zero (it's doing nothing), a legible badge on hover or once
              it's trimmed. A permanent 8px caption over a live spectrum is pollution AND
              unreadable — the two failure modes at once. */}
          <span className="eq-out-badge">
            <span className="eq-out-cap">OUT</span>
            <span ref={outPillRef} className="eq-out-val">
              0.0
            </span>
          </span>
        </div>
        {NODES.map((n, i) => (
          <button
            key={n.key}
            ref={(el) => {
              handleRefs.current[i] = el;
            }}
            className={`eq-node ${n.vert === "q" ? "cut" : ""} ${i === sel ? "selected" : ""}`}
            title={`${n.label} · ${Math.round(n.getFreq(deck))} Hz${n.vert === "gain" ? ` · ${n.getGain(deck) > 0 ? "+" : ""}${n.getGain(deck).toFixed(1)} dB` : ` · Q ${n.getQ(deck).toFixed(1)}`} — right-click to reset`}
            style={{ ["--node" as string]: n.color } as CSSProperties}
            onPointerDown={(e) => startDrag(i, e)}
            onDoubleClick={() => resetNode(n)}
            onContextMenu={(e) => {
              e.preventDefault();
              resetNode(n);
            }}
          />
        ))}
      </div>

      {/* The band-edit row, for the SELECTED node — the node you last touched ON THE CURVE. The
          nodes ARE the selector; there is deliberately no second one down here (a band rail was
          tried and cut as redundant). What's left is only what the selection reassigns:
          (1) SHAPE leads the row, in the band's hue — it isn't a value, it's what the other cells
              MEAN, and its colour is how the row says whose values these are.
          (2) Cells appear and disappear with the shape instead of greying out. A shelf has no Q,
              a notch has no gain — an inert-but-present cell eats width and makes you read a
              label to find out it's dead. What's on screen is what's live.
          Freq/gain/Q stay drag-able on the curve; these are the numeric companion (and a harder
          kill / finer Q than the 2D drag allows). They emit the same `control` intents as the
          nodes, so session-sync + MIDI converge 1:1. */}
      {(() => {
        const n = NODES[clamp(sel, 0, NODES.length - 1)];
        const commit = (param: NonNullable<NodeDef["fParam"] | NodeDef["gParam"] | NodeDef["qParam"] | NodeDef["sParam"]>, getNow: () => number) => {
          emit({ kind: "control", deck: id, param, value: getNow() });
          dirty.current = true;
          bump((x) => x + 1);
        };
        const qReset = n.key === "mid" ? 0.9 : n.key === "hp" ? EQ_HP.q : n.key === "lp" ? EQ_LP.q : 1;
        const shapeType = n.getShape ? EQ_SHAPE_TYPES[clamp(Math.round(n.getShape(deck)), 0, EQ_SHAPE_TYPES.length - 1)] : null;
        // A shelf's Q is meaningless; a notch's gain is meaningless. Don't render them.
        const showQ = !!n.qParam && (shapeType == null || shapeType === "peaking" || shapeType === "notch");
        const showGain = !!n.gParam && shapeType !== "notch";
        return (
          <div className="eq-subrow" style={{ ["--band" as string]: n.color } as CSSProperties}>
            {/* SHAPE — what the band IS, so it leads the row rather than sitting out among the
                band's values. Carries the band's hue, which is also how the row says WHOSE values
                these are. Absent for HP/LP, which have no shape to choose. */}
            {n.sParam && n.getShape && n.setShape && (
              <button
                className="eq-shape-btn"
                title={`${n.label} band shape — tap to cycle bell / lo-shelf / hi-shelf / notch · right-click resets`}
                onClick={() => {
                  const next = (Math.round(n.getShape!(deck)) + 1) % EQ_SHAPE_TYPES.length;
                  n.setShape!(deck, next);
                  commit(n.sParam!, () => n.getShape!(deck));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  n.setShape!(deck, n.sDefault ?? 0);
                  commit(n.sParam!, () => n.getShape!(deck));
                }}
              >
                {EQ_SHAPE_LABELS[clamp(Math.round(n.getShape(deck)), 0, EQ_SHAPE_LABELS.length - 1)]}
              </button>
            )}
            <ValueCell
              label="FREQ"
              value={n.getFreq(deck)}
              min={n.fMin}
              max={n.fMax}
              step={1}
              reset={n.fDefault}
              format={fmtHz}
              onChange={(v) => {
                n.setFreq(deck, v);
                commit(n.fParam, () => n.getFreq(deck));
              }}
            />
            {showGain && (
              <ValueCell
                label="GAIN"
                value={n.getGain(deck)}
                min={EQ_MIN_DB}
                max={EQ_MAX_DB}
                step={0.5}
                pivot={0}
                format={fmtDb}
                onChange={(v) => {
                  n.setGain(deck, v);
                  commit(n.gParam!, () => n.getGain(deck));
                }}
              />
            )}
            {showQ && (
              <ValueCell
                label={n.sParam ? "Q" : "RES"}
                value={n.getQ(deck)}
                min={EQ_Q_MIN}
                max={EQ_Q_MAX}
                step={0.1}
                reset={qReset}
                format={fmtQ}
                onChange={(v) => {
                  n.setQ(deck, v);
                  commit(n.qParam!, () => n.getQ(deck));
                }}
              />
            )}
            {/* No OUT cell, and no wet/dry: neither is a property of the selected BAND. OUT is
                now the draggable baseline on the graph (it always WAS the graph's zero — the
                curve is drawn sitting on it); wet/dry lives in the shared device foot. */}
          </div>
        );
      })()}
    </div>
  );
}

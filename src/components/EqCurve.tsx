import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Deck } from "@htl/audio";
import { EQ_MAX_DB, EQ_HP, EQ_LP, EQ_Q_MIN, EQ_Q_MAX } from "@htl/audio";
import type { Intent } from "@htl/room";

// A pro parametric EQ surface — a simplified FabFilter Pro-Q built on the deck's real
// biquad chain. Up to five nodes you drag in 2D over a live spectrum:
//   HP-cut · LOW shelf · MID bell · HIGH shelf · LP-cut
// Shelves/bell: drag X = frequency, Y = gain (MID wheel/drag-Y peers = bell width).
// Cut nodes: drag X = cutoff, Y = resonance (Q), wheel = Q. The curve is read straight
// off the filters (getFrequencyResponse), so it IS the filter. Extras: the OTHER
// deck's post spectrum overlaid faintly (clash view), long-press a node to audition
// just that band, always-on peak-hold, harmonic guides from the detected key, a
// cursor freq/dB readout, and a BYPASS / RESET / COPY toolbar UNDER the curve.
//
// Rendering is imperative (canvas + rAF, like the waveform) so dragging and the
// animating spectrum never churn React.

const F_MIN = 20;
const F_MAX = 20000;
const F_SPAN = Math.log10(F_MAX / F_MIN);
// Symmetric window so 0 dB sits dead centre (flat curve = line through the middle).
const DB_TOP = 12;
const DB_BOT = -12;
const Q_TOP_PAD = 0.14; // fraction of height reserved above centre for max resonance
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const LONG_PRESS_MS = 220;
const MOVE_CANCEL_PX = 5;
const SOLO_Q = 6; // audition bandpass selectivity

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
  // room-sync param ids
  fParam: "eqLowFreq" | "eqMidFreq" | "eqHighFreq" | "eqHpFreq" | "eqLpFreq";
  gParam?: "eqLow" | "eqMid" | "eqHigh";
  qParam?: "eqMidQ" | "eqHpQ" | "eqLpQ";
}

const NODES: NodeDef[] = [
  { key: "hp", label: "HP", color: "#9aa7ff", vert: "q", fMin: EQ_HP.min, fMax: EQ_HP.max, fDefault: EQ_HP.freq, getFreq: (d) => d.eqHpFreq, setFreq: (d, v) => d.setEqHpFreq(v), getGain: () => 0, setGain: () => {}, getQ: (d) => d.eqHpQ, setQ: (d, v) => d.setEqHpQ(v), fParam: "eqHpFreq", qParam: "eqHpQ" },
  { key: "low", label: "LOW", color: "#ff6b9d", vert: "gain", fMin: 40, fMax: 500, fDefault: 200, getFreq: (d) => d.eqLowFreq, setFreq: (d, v) => d.setEqLowFreq(v), getGain: (d) => d.eqLow, setGain: (d, v) => d.setEqLow(v), getQ: () => 1, setQ: () => {}, fParam: "eqLowFreq", gParam: "eqLow" },
  { key: "mid", label: "MID", color: "#ffd250", vert: "gain", fMin: 200, fMax: 6000, fDefault: 1000, getFreq: (d) => d.eqMidFreq, setFreq: (d, v) => d.setEqMidFreq(v), getGain: (d) => d.eqMid, setGain: (d, v) => d.setEqMid(v), getQ: (d) => d.eqMidQ, setQ: (d, v) => d.setEqMidQ(v), fParam: "eqMidFreq", gParam: "eqMid", qParam: "eqMidQ" },
  { key: "high", label: "HI", color: "#36c2ff", vert: "gain", fMin: 1500, fMax: 16000, fDefault: 3200, getFreq: (d) => d.eqHighFreq, setFreq: (d, v) => d.setEqHighFreq(v), getGain: (d) => d.eqHigh, setGain: (d, v) => d.setEqHigh(v), getQ: () => 1, setQ: () => {}, fParam: "eqHighFreq", gParam: "eqHigh" },
  { key: "lp", label: "LP", color: "#7dffd6", vert: "q", fMin: EQ_LP.min, fMax: EQ_LP.max, fDefault: EQ_LP.freq, getFreq: (d) => d.eqLpFreq, setFreq: (d, v) => d.setEqLpFreq(v), getGain: () => 0, setGain: () => {}, getQ: (d) => d.eqLpQ, setQ: (d, v) => d.setEqLpQ(v), fParam: "eqLpFreq", qParam: "eqLpQ" },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const xFromFreq = (hz: number, w: number) => (Math.log10(hz / F_MIN) / F_SPAN) * w;
const freqFromX = (x: number, w: number) => F_MIN * Math.pow(10, (x / w) * F_SPAN);
const yFromDb = (db: number, h: number) => ((DB_TOP - db) / (DB_TOP - DB_BOT)) * h;
const dbFromY = (y: number, h: number) => DB_TOP - (y / h) * (DB_TOP - DB_BOT);
const qNorm = (q: number) => Math.log(q / EQ_Q_MIN) / Math.log(EQ_Q_MAX / EQ_Q_MIN);
const yFromQ = (q: number, h: number) => h / 2 - clamp(qNorm(q), 0, 1) * (h / 2 - h * Q_TOP_PAD);
const qFromY = (y: number, h: number) => {
  const n = clamp((h / 2 - y) / (h / 2 - h * Q_TOP_PAD), 0, 1);
  return EQ_Q_MIN * Math.pow(EQ_Q_MAX / EQ_Q_MIN, n);
};

interface EqCurveProps {
  deck: Deck;
  id: "A" | "B";
  accent: string;
  otherDeck: Deck;
  otherAccent: string;
  emit: (intent: Intent) => void;
  emitControls: (id: "A" | "B") => void;
  refresh: () => void;
}

export function EqCurve({ deck, id, accent, otherDeck, otherAccent, emit, emitControls, refresh }: EqCurveProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const handleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const freqs = useRef<Float32Array>(new Float32Array(0));
  const magBuf = useRef<Float32Array>(new Float32Array(0));
  const specBuf = useRef<Uint8Array>(new Uint8Array(0));
  const otherSpec = useRef<Uint8Array>(new Uint8Array(0));
  const peakBuf = useRef<Uint8Array>(new Uint8Array(0));
  const dirty = useRef(true);
  // active gesture on a node: drag (sweep) or hold-to-audition
  const drag = useRef<{ i: number; moved: boolean; timer: number; audition: boolean } | null>(null);
  // when auditioning, the soloed centre freq (+ Q) so the draw loop can spotlight it
  const soloViz = useRef<{ freq: number; q: number } | null>(null);
  const [, bump] = useState(0);

  const otherId = id === "A" ? "B" : "A";

  // (Re)size canvas + per-pixel buffers to the element box.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(wrap.clientWidth));
      const h = Math.max(1, Math.round(wrap.clientHeight));
      size.current = { w, h, dpr };
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
      if (deck.playing || otherDeck.playing || dirty.current) {
        draw();
        dirty.current = false;
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
      const { w, h, dpr } = size.current;
      if (!canvas || w === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

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

      // the real combined EQ response curve + fill to the 0 dB line
      deck.eqMagnitude(freqs.current, magBuf.current);
      const y0 = yFromDb(0, h);
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

      // audition spotlight: dim everything outside the soloed band, glow inside it,
      // bright centre line — follows the sweep live so you see what you're hearing.
      const sv = soloViz.current;
      if (sv) {
        const edge = Math.pow(2, 0.6 / sv.q); // half-bandwidth in octaves, narrower at high Q
        const xLo = clamp(xFromFreq(sv.freq / edge, w), 0, w);
        const xHi = clamp(xFromFreq(sv.freq * edge, w), 0, w);
        const xC = xFromFreq(sv.freq, w);
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(0, 0, xLo, h);
        ctx.fillRect(xHi, 0, w - xHi, h);
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(xLo, 0, xHi - xLo, h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(xC, 0);
        ctx.lineTo(xC, h);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // reposition node dots to match the live filter
      for (let i = 0; i < NODES.length; i++) {
        const el = handleRefs.current[i];
        if (!el) continue;
        const n = NODES[i];
        // Keep the dot (and its label) a hair inside the box so the edge HP/LP nodes
        // parked at 20 Hz / 20 kHz don't clip off-screen.
        el.style.left = `${clamp(xFromFreq(n.getFreq(deck), w), 11, w - 11)}px`;
        el.style.top = `${n.vert === "gain" ? yFromDb(n.getGain(deck), h) : yFromQ(n.getQ(deck), h)}px`;
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
    const { w, h } = size.current;
    const hz = clamp(freqFromX(clientX - rect.left, w), n.fMin, n.fMax);
    n.setFreq(deck, hz);
    emit({ kind: "control", deck: id, param: n.fParam, value: n.getFreq(deck) });
    if (n.vert === "gain" && n.gParam) {
      const db = clamp(dbFromY(clientY - rect.top, h), DB_BOT, EQ_MAX_DB);
      n.setGain(deck, db);
      emit({ kind: "control", deck: id, param: n.gParam, value: n.getGain(deck) });
    } else if (n.vert === "q" && n.qParam) {
      const q = clamp(qFromY(clientY - rect.top, h), EQ_Q_MIN, EQ_Q_MAX);
      n.setQ(deck, q);
      emit({ kind: "control", deck: id, param: n.qParam, value: q });
    }
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // cursor readout (when not dragging a node)
    const ro = readoutRef.current;
    const wrap = wrapRef.current;
    if (ro && wrap && !drag.current) {
      const rect = wrap.getBoundingClientRect();
      const { w } = size.current;
      const x = e.clientX - rect.left;
      if (x >= 0 && x <= w) {
        const hz = freqFromX(x, w);
        const idx = clamp(Math.round(x), 0, w - 1);
        const db = magBuf.current[idx] ?? 0;
        ro.style.opacity = "1";
        ro.style.left = `${clamp(x, 30, w - 30)}px`;
        ro.textContent = `${hz < 1000 ? Math.round(hz) + " Hz" : (hz / 1000).toFixed(1) + " kHz"} · ${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
      }
    }
    const g = drag.current;
    if (!g) return;
    const n = NODES[g.i];
    if (!g.moved) {
      const dx = Math.abs(e.movementX) + Math.abs(e.movementY);
      if (dx > MOVE_CANCEL_PX) {
        g.moved = true;
        clearTimeout(g.timer);
      }
    }
    if (g.audition) {
      // sweep the audition frequency by dragging — the spotlight tracks live
      const rect = wrapRef.current!.getBoundingClientRect();
      const hz = clamp(freqFromX(e.clientX - rect.left, size.current.w), F_MIN, F_MAX);
      deck.soloBand(hz, SOLO_Q);
      soloViz.current = { freq: hz, q: SOLO_Q };
      dirty.current = true;
      return;
    }
    applyDrag(n, e.clientX, e.clientY);
  };

  const startDrag = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const timer = window.setTimeout(() => {
      const g = drag.current;
      if (g && !g.moved) {
        g.audition = true;
        const n = NODES[g.i];
        const hz = n.getFreq(deck);
        deck.soloBand(hz, SOLO_Q);
        soloViz.current = { freq: hz, q: SOLO_Q };
        dirty.current = true;
        bump((x) => x + 1);
      }
    }, LONG_PRESS_MS);
    drag.current = { i, moved: false, timer, audition: false };
  };
  const endDrag = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.audition) {
      deck.clearSolo();
      soloViz.current = null;
      dirty.current = true;
    }
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    bump((x) => x + 1);
  };
  const hideReadout = () => {
    if (readoutRef.current && !drag.current) readoutRef.current.style.opacity = "0";
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

  // --- toolbar actions ---
  const toggleBypass = () => {
    deck.setEqBypass(!deck.eqBypassed);
    emit({ kind: "toggle", deck: id, param: "eqBypass", value: deck.eqBypassed });
    dirty.current = true;
    bump((x) => x + 1);
  };
  const flat = () => {
    deck.resetEq();
    emitControls(id);
    emit({ kind: "toggle", deck: id, param: "eqBypass", value: false });
    dirty.current = true;
    refresh();
  };
  const copyToOther = () => {
    otherDeck.setEqLow(deck.eqLow);
    otherDeck.setEqMid(deck.eqMid);
    otherDeck.setEqHigh(deck.eqHigh);
    otherDeck.setEqLowFreq(deck.eqLowFreq);
    otherDeck.setEqMidFreq(deck.eqMidFreq);
    otherDeck.setEqHighFreq(deck.eqHighFreq);
    otherDeck.setEqMidQ(deck.eqMidQ);
    otherDeck.setEqHpFreq(deck.eqHpFreq);
    otherDeck.setEqHpQ(deck.eqHpQ);
    otherDeck.setEqLpFreq(deck.eqLpFreq);
    otherDeck.setEqLpQ(deck.eqLpQ);
    emitControls(otherId);
    refresh();
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
        <div ref={readoutRef} className="eq-readout" style={{ opacity: 0 }} />
        {NODES.map((n, i) => (
          <button
            key={n.key}
            ref={(el) => {
              handleRefs.current[i] = el;
            }}
            className={`eq-node ${drag.current?.i === i && drag.current?.audition ? "audition" : ""} ${n.vert === "q" ? "cut" : ""}`}
            title={`${n.label} · ${Math.round(n.getFreq(deck))} Hz${n.vert === "gain" ? ` · ${n.getGain(deck) > 0 ? "+" : ""}${n.getGain(deck).toFixed(1)} dB` : ` · Q ${n.getQ(deck).toFixed(1)}`} — hold to audition, right-click to reset`}
            style={{ ["--node" as string]: n.color } as CSSProperties}
            onPointerDown={(e) => startDrag(i, e)}
            onDoubleClick={() => resetNode(n)}
            onContextMenu={(e) => {
              e.preventDefault();
              resetNode(n);
            }}
          >
            <span className="eq-node-label">{n.label}</span>
          </button>
        ))}
      </div>
      {/* Controls sit UNDER the curve. */}
      <div className="eq-tools">
        <button className={`eq-tool ${deck.eqBypassed ? "on" : ""}`} title="Bypass the EQ (A/B)" onClick={toggleBypass}>BYPASS</button>
        <button className="eq-tool" title="Reset the EQ to flat" onClick={flat}>RESET</button>
        <button className="eq-tool" title={`Copy this EQ to deck ${otherId}`} onClick={copyToOther}>COPY →{otherId}</button>
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { Deck, ReverbFx } from "@htl/audio";
import { dragBand, dragHp, dragLp, drawFreqRibbon, fmtHz, hitFreqRibbon, type RibbonHot, type RibbonRange } from "./FreqRibbon";

// Reverb tail view, v5 — an INVERTED half-ellipse dome: the source sits right where the ribbon
// ends (the top), and the tail hangs DOWN from it, falling away into the room below — instead of
// rising from a floor. This is what lets "the ribbon goes at the top, like delay" and "bring back
// the semi-circle" compose: the dome's own baseline IS the ribbon's edge now, not a separate floor
// competing with it for the panel's bottom.
//   • THE BASELINE (top, under the ribbon) = the source; a dark disc there = the PREDELAY gap.
//   • DOWNWARD reach = time → the diffuse fog falls further as the tail decays.
//   • ANGLE across the arch = FREQUENCY, left → low, through the nadir, to right → high; the rim
//     CURVE's reach at each angle = how long that band rings.
// DIRECT CONTROL — 7 grips, each a dot on a FIXED spoke, dragged in/out along a track, absolute
// (grab-offset, no jump), every one PERMANENTLY labelled (naming was hover-only on the very first
// dome, which is exactly why the dots read as unlabeled at a glance). shift-wheel on DECAY → CHAR,
// on WIDTH → RATE. wheel nudges a grip; dbl-click / right-click resets it.

interface ReverbVizProps {
  size: number; // 0..1 footprint
  decay: number; // 0..1 tail reach
  brightness: number; // 0..1 HF decay (1 = HF rings on)
  predelay: number; // seconds
  width: number; // 0..1.5 stereo spread
  lowCut: number; // Hz — tail low-cut
  highCut: number; // Hz — tail high-cut
  mix: number; // 0..1 wet → fog presence
  drive: number; // 0..1 input saturation → warm core
  duck: number; // 0..1 sidechain → the bloom breathes
  character: number; // 0..1 modulation depth
  modRate: number; // Hz
  frozen: boolean;
  accent: string;
  onParam: (param: string, value: number) => void; // direct-control callback (drag/wheel)
  deck?: Deck; // for the live wet-signal tap (the room field reacts to the music)
  slot?: number;
}

// A reflection mote dispersing into the wings (the living room field — see the draw loop).
interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  warm: boolean; // DRIVE-warmed colour
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const TWO_PI = Math.PI * 2;
const WARM = "255,150,70"; // DRIVE glow colour

const GRAB_PX = 26; // pointer-to-grip hit radius (generous — the grips ARE the controls)
const NODE_R = 6.5; // grip dot radius
const READOUT_H = 13; // the one readout strip, across the top — same contract as the delay's
const NARROW_PX = 260; // below this the deck is a phone column, not a desktop panel
const RIBBON_GRIP_PX = 10; // how close counts as "on" a ribbon edge (delay's GRIP_PX)
const LABEL_PAD = 13; // reserved floor room for the deepest grip's label (the arc's nadir)

// The arch spans a FULL half-turn for the frequency curve (0..π: left → nadir → right), but the
// 7 grips inset from both horizons — MORE than a token amount this time. The first pass put them
// only ~12° in, which gave them almost no vertical drop (sin of a small angle is small) even
// though they sat far out horizontally — that mismatch (far sideways, barely hanging down) is
// specifically why they read as isolated dots stuck to the baseline instead of part of the arc.
const ARC_MARGIN = 0.38; // radians (~22°) — enough real drop that every grip visibly hangs
const ARC_SPAN = Math.PI - 2 * ARC_MARGIN;
const N_GRIPS = 7;
const ARC_STEP = ARC_SPAN / (N_GRIPS - 1);
const gripAngle = (i: number) => Math.PI - ARC_MARGIN - i * ARC_STEP; // i=0 left ‥ i=6 right
const GRIP_R_IN = 0.36; // fraction of the dome's reach — the inner end of every grip's track
const GRIP_R_OUT = 0.86; // ...the outer end (headroom kept for the permanent label past it)

// ReverbFx's own real DSP bounds (ReverbFx.ts) — asymmetric, not one shared range like the
// delay's cuts. Passing anything looser would let this ribbon's grip drift somewhere the DSP
// silently clamps back from underneath it.
const RIBBON_RANGE: RibbonRange = { loMin: 20, loMax: 2000, hiMin: 1000, hiMax: 20000, minRatio: 1.1 };

// The live dome geometry — set each draw, read by the pointer handlers (which live in a
// different closure and only see the canvas via getBoundingClientRect, same CSS-pixel space).
interface Ctx {
  w: number;
  h: number;
  cx: number;
  cy: number; // the baseline, right under the ribbon — everything hangs FROM here now
  aX: number; // the dome's OWN semi-axis — capped, a fixed-size instrument regardless of width
  aY: number; // vertical semi-axis — fills the space below the ribbon
  aXraw: number; // the panel's actual available half-width, uncapped — for the room field only
  ribbonY: number;
  ribbonH: number;
}

const toXY = (ang: number, frac: number, c: Ctx) => ({ x: c.cx + Math.cos(ang) * frac * c.aX, y: c.cy + Math.sin(ang) * frac * c.aY });

interface Grip {
  id: string;
  param: string;
  label: string;
  angle: number;
  min: number;
  max: number;
  def: number;
  fmt: (v: number) => string;
  rIn: number;
  rOut: number;
  sec?: { param: string; min: number; max: number }; // shift-wheel secondary
}
const pct = (v: number) => `${Math.round(v * 100)}`;
const ms = (v: number) => `${Math.round(v * 1000)}ms`;
const GRIPS: Grip[] = [
  { id: "predelay", param: "predelay", label: "PREDLY", angle: gripAngle(0), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 0.2, def: 0.012, fmt: ms },
  { id: "width", param: "width", label: "WIDTH", angle: gripAngle(1), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 1.5, def: 1, fmt: pct, sec: { param: "modRate", min: 0.02, max: 6 } },
  { id: "size", param: "size", label: "SIZE", angle: gripAngle(2), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 1, def: 0.6, fmt: pct },
  // ★ DECAY sits at the arch's NADIR — the deepest, furthest-from-the-source point, which is now
  // the most thematically honest spot for it: decay is literally how far the tail falls.
  { id: "decay", param: "decay", label: "DECAY", angle: gripAngle(3), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 1, def: 0.5, fmt: pct, sec: { param: "character", min: 0, max: 1 } },
  { id: "duck", param: "duck", label: "DUCK", angle: gripAngle(4), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 1, def: 0, fmt: pct },
  { id: "drive", param: "drive", label: "DRIVE", angle: gripAngle(5), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 1, def: 0, fmt: pct },
  { id: "bright", param: "brightness", label: "BRIGHT", angle: gripAngle(6), rIn: GRIP_R_IN, rOut: GRIP_R_OUT, min: 0, max: 1, def: 0.6, fmt: pct },
];
const gripNorm = (g: Grip, v: number) => clamp01((v - g.min) / (g.max - g.min));
const gripVal = (g: Grip, n: number) => g.min + clamp01(n) * (g.max - g.min);
const gripFrac = (g: Grip, v: number) => g.rIn + gripNorm(g, v) * (g.rOut - g.rIn); // param → track fraction
const gripParamAt = (g: Grip, frac: number) => gripVal(g, (frac - g.rIn) / (g.rOut - g.rIn)); // track fraction → param

interface Placed extends Grip {
  x: number;
  y: number;
}

type Drag = { kind: "grip"; grip: Grip; offset: number } | { kind: "ribbon"; which: Exclude<RibbonHot, null>; lastX: number };

export function ReverbViz({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent, onParam, deck, slot }: ReverbVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Living room field: the wet-signal energy tap + the reflection motes drifting into the wings.
  const anRef = useRef<AnalyserNode | null>(null);
  const anBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const energyRef = useRef(0); // smoothed wet RMS (0..1) — drives spawn rate + glow
  const motes = useRef<Mote[]>([]);
  const spawnAcc = useRef(0);
  const lastNowRef = useRef(0);

  const params = useRef({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate });
  params.current = { size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate };
  const onParamRef = useRef(onParam);
  onParamRef.current = onParam;
  const ctxRef = useRef<Ctx>({ w: 1, h: 1, cx: 0, cy: 0, aX: 1, aY: 1, aXraw: 1, ribbonY: 0, ribbonH: 1 });
  const placed = useRef<Placed[]>([]);
  const hover = useRef<string | null>(null); // a grip id, or "hp"/"lp"/"band"
  const drag = useRef<Drag | null>(null);
  const lastTap = useRef(0);
  const drawRef = useRef<(now: number) => void>(() => {});
  const nowRef = useRef(0);

  // Tap the device's wet output so the room field reacts to what's actually being fed in.
  useEffect(() => {
    if (!deck || slot == null) return;
    const dev = deck.fxDeviceAt(slot);
    if (!dev) return;
    const actx = dev.output.context;
    const an = actx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.6;
    try {
      dev.output.connect(an);
    } catch {
      /* ignore */
    }
    anRef.current = an;
    anBufRef.current = new Float32Array(an.fftSize);
    return () => {
      try {
        dev.output.disconnect(an);
      } catch {
        /* ignore */
      }
      anRef.current = null;
    };
  }, [deck, slot]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    let lastW = 0;
    let lastH = 0;
    let lastDpr = 0;
    const sizeCanvas = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      if (w !== lastW || h !== lastH || dpr !== lastDpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        lastW = w;
        lastH = h;
        lastDpr = dpr;
      }
      return { w, h, dpr };
    };
    const start = window.performance.now();
    // low = LEFT, through the NADIR, to high = RIGHT — a spectrum reads left to right everywhere
    // else in this app; the dome does too.
    const angOf = (fNorm: number) => Math.PI - fNorm * Math.PI;

    // Geometry, shared by the renderer and the hit-tests. Top to bottom: the READOUT strip, the
    // tone RIBBON, then the dome — hanging DOWN from the ribbon's own baseline.
    const geom = (w: number, h: number): Ctx => {
      const narrow = w < NARROW_PX;
      const ribbonH = narrow ? Math.max(26, Math.round(h * 0.22)) : Math.max(20, Math.round(h * 0.2));
      const ribbonY = READOUT_H;
      const cx = w / 2;
      const cy = ribbonY + ribbonH + 3; // the dome's own baseline sits right under the ribbon
      const domeBot = h - LABEL_PAD - 2; // headroom for the nadir grip's label
      const marginX = narrow ? 10 : 18;
      const aYraw = Math.max(20, domeBot - cy);
      const aXraw = Math.max(20, w / 2 - marginX);
      // A TRUE semicircle — never an ellipse. Letting aX run out to the panel's full half-width
      // (however much wider than it is tall) is what read as "stretchy": a squashed oval instead
      // of a dome. The tighter of the two axes wins; whatever width is left over becomes the
      // room-field's wings instead of distorting the dome's own shape.
      const aY = Math.min(aYraw, aXraw);
      // ★ FIXED-SIZE INSTRUMENT — capped at a constant multiple of aY, so the dome stays the same
      // comfortable proportions whether this canvas is a normal rack strip or a doubled-width
      // expanded single-deck view. The height never grows in either case, so unbounded aX (the
      // panel's real half-width) can go arbitrarily far past what looks like a dome and into
      // "stretched oval" — capping it, instead of letting it track the panel, is what makes an
      // expanded view leave leftover space rather than a distorted shape. The room field below
      // gets that leftover space instead (see aXraw), so it reads as deliberate atmosphere, not a
      // control surface that gave up trying to fill its own container.
      const aX = Math.min(aXraw, aY * 2.2);
      return { w, h, cx, cy, aX, aY, aXraw, ribbonY, ribbonH };
    };

    const draw = (now: number) => {
      nowRef.current = now;
      const dt = lastNowRef.current ? Math.min(0.05, (now - lastNowRef.current) / 1000) : 0.016;
      lastNowRef.current = now;
      const { w, h, dpr } = sizeCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // live wet energy (smoothed RMS) — the room field swells with the music.
      const an = anRef.current;
      const buf = anBufRef.current;
      let e = 0;
      if (an && buf) {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        e = clamp01(Math.sqrt(s / buf.length) * 3.2);
      }
      energyRef.current += (e - energyRef.current) * 0.25;

      const c = geom(w, h);
      ctxRef.current = c;
      const { cx, cy, aX, aY } = c;
      const p = params.current;
      const sizeScale = 0.6 + clamp01(p.size) * 0.4;
      const Rfrac = sizeScale; // the room boundary, as a fraction of (aX,aY)
      const r0inner = 0.1 + clamp01(p.predelay / 0.2) * 0.22; // predelay gap, as a fraction OF Rfrac
      const r0frac = Rfrac * r0inner;
      const spanFrac = Rfrac - r0frac;
      const elapsed = (now - start) / 1000;
      const phase = TWO_PI * p.modRate * elapsed;
      const reachBase = frozen ? 1 : 0.18 + clamp01(p.decay) * 0.82;
      const mixA = 0.32 + clamp01(p.mix) * 0.68;
      const dr = clamp01(p.drive);
      // ★ THE REAL SIDECHAIN, not a canned oscillation — see htl-webaudio-footguns (AudioParam
      // .value can't see modulation delivered via .connect()). ReverbFx.duckGain is tapped live.
      const dev = deck?.fxDeviceAt(slot ?? -1) as ReverbFx | undefined;
      const duckPulse = dev ? clamp01(dev.duckGain) : 1;
      const coreRpx = Math.max(3, Rfrac * aY * 0.14) * (1 + dr * 1.1) * duckPulse;
      const fogRfrac = Rfrac * reachBase * duckPulse;
      const fogRpx = fogRfrac * aY;
      const r0px = r0frac * aY;

      const held = drag.current ? (drag.current.kind === "grip" ? drag.current.grip.id : drag.current.which) : null;
      const hot = held ?? hover.current;
      const hotGrip = hot ? GRIPS.find((g) => g.id === hot) ?? null : null;
      const hotRibbon: RibbonHot = hot === "hp" || hot === "lp" || hot === "band" ? hot : null;

      // === THE FILTER RIBBON — shared with the delay's tap timeline (FreqRibbon.ts). Sits at the
      //     very top, right under the readout — the dome's own baseline picks up immediately
      //     after it, so the source and the ribbon read as the same edge. ===
      drawFreqRibbon(ctx, { x: 0, y: c.ribbonY, w, h: c.ribbonH - 4 }, p.lowCut, p.highCut, accent, hotRibbon);

      // === LIVING ROOM FIELD — fills the wide panel's empty side bands with the reverb's energy
      //     dispersing into the room. Drawn BEHIND the dome. A horizontal glow + reflection motes
      //     that fan OUTWARD from the arch's two horizons (spread by WIDTH, reach/lifetime by
      //     DECAY, presence by MIX), breathing with DUCK and pulsing with the live wet signal. The
      //     dome itself is now a FIXED size (see aX above) — this field is what makes the leftover
      //     space on a very wide panel read as deliberate atmosphere instead of empty dead air. ===
      const energy = energyRef.current;
      const Rx = Rfrac * aX;
      const wing = w / 2 - Rx; // empty horizontal space beyond the arch's horizons
      if (wing > 40) {
        // DISTANT ROOM ECHOES — flat ripples using the panel's FULL available half-width
        // (aXraw, not the dome's own capped reach), so a doubled-width expanded view still reads
        // as "the room continues out there." Deliberately FLAT (a small fixed height, not another
        // dome) — this is ripples on the floor, not a second stretched arch.
        if (c.aXraw > aX * 1.15) {
          const echoAY = Math.min(aY * 0.22, 16);
          for (let i = 0; i < 3; i++) {
            const rr = 0.5 + i * 0.24;
            const ea = (0.12 + 0.06 * clamp01(p.mix)) * (0.7 + 0.3 * energy) * duckPulse * (1 - i * 0.2);
            ctx.beginPath();
            for (let k = 0; k <= 48; k++) {
              const ang = (k / 48) * Math.PI;
              const x = cx + Math.cos(ang) * rr * c.aXraw;
              const y = cy + Math.sin(ang) * rr * echoAY;
              k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.strokeStyle = withAlpha(accent, ea);
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        const wingA = (0.08 + 0.09 * clamp01(p.mix)) * (0.6 + 0.4 * energy) * duckPulse;
        const wg = ctx.createRadialGradient(cx, cy, Rx * 0.7, cx, cy, w * 0.62);
        wg.addColorStop(0, withAlpha(dr > 0 ? `rgb(${WARM})` : accent, wingA));
        wg.addColorStop(1, withAlpha(accent, 0));
        ctx.fillStyle = wg;
        ctx.fillRect(0, 0, w, h);

        // Density SCALES WITH the actual wing size — a doubled-width panel gets a denser field,
        // not the same handful of motes spread twice as thin.
        const wingBoost = clamp(wing / 130, 0.7, 2.4);
        const moteCap = Math.round(70 * wingBoost);
        spawnAcc.current += dt * (1.5 + energy * 16 + clamp01(p.decay) * 5) * (0.4 + clamp01(p.mix)) * wingBoost;
        const spread = 0.5 + clamp01(p.width / 1.5) * 1.4;
        while (spawnAcc.current >= 1 && motes.current.length < moteCap) {
          spawnAcc.current -= 1;
          const dir = (now * 997 + motes.current.length) % 2 < 1 ? -1 : 1; // alternate-ish L/R
          const vj = (((now * 131 + motes.current.length * 53) % 100) / 100 - 0.5) * 0.5; // vert jitter
          const ang = (dir > 0 ? 0 : Math.PI) + vj; // the arch's horizons — mostly horizontal
          const speed = (38 + clamp01(p.decay) * 130) * (0.6 + energy * 0.8);
          const life = 0.5 + clamp01(p.decay) * 1.8;
          const ox = cx + Math.cos(ang) * Rx;
          const oy = cy + Math.sin(ang) * (Rfrac * aY);
          motes.current.push({ x: ox, y: oy, vx: Math.cos(ang) * speed * spread, vy: Math.sin(ang) * speed * 0.5, life, max: life, warm: dr > 0.2 && (now % 100) / 100 < dr });
        }
        const arr = motes.current;
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr[i];
          m.life -= dt;
          if (m.life <= 0) {
            arr.splice(i, 1);
            continue;
          }
          m.x += m.vx * dt;
          m.y += m.vy * dt;
          m.vx *= 0.985;
          m.vy *= 0.985;
          const u = m.life / m.max;
          const a = u * u * (0.32 + clamp01(p.mix) * 0.68) * (0.5 + 0.5 * energy) * duckPulse;
          const rr = 1.2 + (1 - u) * 2.2;
          ctx.beginPath();
          ctx.arc(m.x, m.y, rr, 0, TWO_PI);
          ctx.fillStyle = withAlpha(m.warm ? `rgb(${WARM})` : accent, a);
          ctx.shadowColor = m.warm ? `rgb(${WARM})` : accent;
          ctx.shadowBlur = 6;
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      } else if (motes.current.length) {
        motes.current.length = 0; // no wings at this size — drop the field
      }

      // ★ NOT a function of lowCut/highCut — the ribbon is the ONLY place the tone window shows.
      // This used to also pinch the curve's shape at the band edges (a `band` term keyed off the
      // same cuts), which quietly duplicated the ribbon's own job inside the dome — one control
      // shouldn't paint itself twice in two different places on the same panel.
      const reachAt = (fNorm: number) => {
        const tilt = 1 - (1 - clamp01(p.brightness)) * fNorm * 0.85;
        const skew = 1 + (p.width - 1) * 0.16 * Math.sin(fNorm * Math.PI);
        const wob = p.character > 0 ? p.character * 0.05 * Math.sin(fNorm * 8 - phase) : 0;
        return clamp01(r0inner + reachBase * tilt * skew * (1 - r0inner) + wob) * duckPulse;
      };

      // === circular FILLS (bloom / predelay disc / drive core) — an anisotropic scale draws them
      //     as true ellipses without hand-computing each point; none of the three are STROKED, so
      //     the scale's only cost is a fill, not an uneven line weight. Lower half (0..π) — the
      //     dome hangs DOWN from the baseline now. ===
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(aX / aY, 1);
      const bloomR = Math.max(r0px + 1, fogRpx);
      const grad = ctx.createRadialGradient(0, 0, r0px * 0.6, 0, 0, bloomR);
      grad.addColorStop(0, dr > 0 ? `rgba(${WARM},${(0.34 + dr * 0.3) * mixA})` : withAlpha(accent, 0.4 * mixA));
      grad.addColorStop(0.5, withAlpha(accent, 0.14 * mixA));
      grad.addColorStop(1, withAlpha(accent, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, bloomR, 0, Math.PI);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.arc(0, 0, r0px, 0, Math.PI);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();

      if (dr > 0) {
        ctx.shadowColor = `rgba(${WARM},0.95)`;
        ctx.shadowBlur = 8 + dr * 26;
        ctx.fillStyle = `rgba(${WARM},${0.55 + dr * 0.4})`;
      } else {
        ctx.fillStyle = withAlpha(accent, 0.85);
      }
      ctx.beginPath();
      ctx.arc(0, 0, coreRpx, 0, Math.PI);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // === STROKED half-arcs — the size boundary + drifting energy rings + the decay-rate curve
      //     itself — built as explicit polylines via the ellipse projection, not ctx.arc under a
      //     scale transform, so a stroke's width reads the same at the nadir as at the horizons. ===
      const halfArcPath = (rFrac: number, steps = 64) => {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const ang = (i / steps) * Math.PI;
          const { x, y } = toXY(ang, rFrac, c);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      };

      halfArcPath(Rfrac);
      ctx.strokeStyle = withAlpha(accent, 0.1 + clamp01(p.size) * 0.12);
      ctx.lineWidth = 1;
      ctx.stroke();

      const RINGS = 4;
      for (let i = 0; i < RINGS; i++) {
        const u = (elapsed * 0.16 + i / RINGS) % 1;
        const rFrac = r0frac + u * (fogRfrac - r0frac);
        halfArcPath(Math.max(0.001, rFrac));
        const a = (frozen ? 0.2 : 0.24 * (1 - u)) * (0.5 + 0.5 * clamp01(p.decay)) * mixA;
        ctx.strokeStyle = withAlpha(accent, a);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const fNorm = i / 120;
        const rFrac = r0frac + reachAt(fNorm) * spanFrac;
        const { x, y } = toXY(angOf(fNorm), rFrac, c);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = withAlpha(accent, 0.1 * mixA);
      ctx.fill();
      ctx.strokeStyle = withAlpha(accent, 0.85);
      ctx.lineWidth = 1.5;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 5;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // === place + draw the GRIPS, each with a PERMANENT short label — the whole point of
      //     freeing up the arc's width was to make these self-explanatory without a hover. ===
      placed.current = GRIPS.map((g) => {
        const frac = gripFrac(g, (p as Record<string, number>)[g.param]);
        const { x, y } = toXY(g.angle, frac, c);
        return { ...g, x, y };
      });

      for (const g of placed.current) {
        const isHot = hot === g.id;
        const inner = toXY(g.angle, 0.1, c);
        const outer = toXY(g.angle, g.rOut, c);
        ctx.strokeStyle = withAlpha(accent, isHot ? 0.3 : 0.1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(inner.x, inner.y);
        ctx.lineTo(outer.x, outer.y);
        ctx.stroke();
      }
      for (const g of placed.current) {
        const isHot = hot === g.id;
        ctx.beginPath();
        ctx.arc(g.x, g.y, isHot ? NODE_R + 2.5 : NODE_R, 0, TWO_PI);
        ctx.fillStyle = isHot ? "#fff" : withAlpha(accent, 0.95);
        ctx.shadowColor = accent;
        ctx.shadowBlur = isHot ? 12 : 5;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = withAlpha(accent, isHot ? 1 : 0.55);
        ctx.stroke();

        // The label always renders — naming was hover-only on the very first dome, which is
        // exactly why the dots read as unlabeled at a glance. Anchored BELOW the dot (the dome
        // hangs down now, so "away from the bulk" points further down-and-out, not up).
        const cosA = Math.cos(g.angle);
        ctx.font = isHot ? "700 9px system-ui, sans-serif" : "600 8px system-ui, sans-serif";
        ctx.textAlign = cosA < -0.25 ? "right" : cosA > 0.25 ? "left" : "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isHot ? "#fff" : withAlpha(accent, 0.65);
        ctx.fillText(g.label, g.x, g.y + NODE_R + 3);
      }

      // === THE READOUT — same 3-zone contract as the delay: LEFT = what the reverb IS, MIDDLE =
      //     what you're TOUCHING (blank when you aren't), RIGHT = its tone (or FROZEN). ===
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, w, READOUT_H - 1);
      const ry = (READOUT_H - 1) / 2;
      ctx.font = "800 9px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = accent;
      ctx.textAlign = "left";
      ctx.globalAlpha = 0.9;
      ctx.fillText(`${Math.round(clamp01(p.decay) * 100)}%  ·  ${Math.round(clamp01(p.size) * 100)}%`, 5, ry);
      ctx.textAlign = "right";
      if (frozen) {
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(elapsed * 3));
        ctx.fillText("❄ FROZEN", w - 5, ry);
      } else {
        ctx.globalAlpha = 0.55;
        ctx.fillText(`${fmtHz(p.lowCut)} – ${fmtHz(p.highCut)}`, w - 5, ry);
      }
      ctx.globalAlpha = 1;
      const ctxLabel = hotGrip ? `${hotGrip.label} ${hotGrip.fmt((p as Record<string, number>)[hotGrip.param])}` : hotRibbon ? `${fmtHz(p.lowCut)} Hz – ${fmtHz(p.highCut)} Hz` : "";
      if (ctxLabel) {
        ctx.textAlign = "center";
        ctx.globalAlpha = 1;
        ctx.fillStyle = drag.current ? "#fff" : accent;
        ctx.fillText(ctxLabel, w / 2, ry);
      }
      ctx.globalAlpha = 1;
    };
    drawRef.current = draw;

    let raf = 0;
    const loop = (now: number) => {
      draw(now);
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => draw(nowRef.current || start));
    ro.observe(wrap);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent, deck, slot]);

  // --- direct control: hit-test grips + ribbon, map drag → param -------------------------------
  const localPt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  // Ellipse-normalized radial distance from centre: dividing each axis by its own semi-axis first
  // turns the ellipse into a unit circle, so ordinary Euclidean distance in THAT space is the
  // fraction of the dome's reach — regardless of which way the pointer has drifted off a grip's
  // exact spoke, same as a circular radOf ignores angular drift and uses raw distance.
  const fracOf = (x: number, y: number) => {
    const c = ctxRef.current;
    return Math.hypot((x - c.cx) / c.aX, (y - c.cy) / c.aY);
  };
  const nearest = (x: number, y: number): Placed | null => {
    let best: Placed | null = null;
    let bestD = GRAB_PX;
    for (const g of placed.current) {
      const d = Math.hypot(x - g.x, y - g.y);
      if (d <= bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  };
  const inRibbon = (y: number) => {
    const c = ctxRef.current;
    return y >= c.ribbonY && y <= c.ribbonY + c.ribbonH;
  };
  const redraw = () => drawRef.current(nowRef.current || window.performance.now());

  // Native, non-passive wheel — nudge the hovered grip (shift = its secondary), like ValueCell.
  // Ribbon edges don't get wheel-nudge, matching the delay's own ribbon (no wheel there either).
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const pt = localPt(e);
      if (inRibbon(pt.y)) return;
      const g = nearest(pt.x, pt.y) ?? (hover.current ? placed.current.find((p) => p.id === hover.current) ?? null : null);
      if (!g) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const tgt = e.shiftKey && g.sec ? g.sec : { param: g.param, min: g.min, max: g.max };
      const cur = (params.current as Record<string, number>)[tgt.param];
      onParamRef.current(tgt.param, clamp(cur + (dir * (tgt.max - tgt.min)) / 40, tgt.min, tgt.max));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className="rv-viz"
      ref={wrapRef}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // right-button resets via onContextMenu
        const pt = localPt(e);
        if (inRibbon(pt.y)) {
          const c = ctxRef.current;
          const grip = c.w < NARROW_PX ? RIBBON_GRIP_PX * 1.6 : RIBBON_GRIP_PX;
          const kind = hitFreqRibbon(pt.x, pt.y, { x: 0, y: c.ribbonY, w: c.w, h: c.ribbonH }, params.current.lowCut, params.current.highCut, grip);
          if (kind) {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { kind: "ribbon", which: kind, lastX: pt.x };
            hover.current = kind;
            redraw();
          }
          return;
        }
        const g = nearest(pt.x, pt.y);
        if (!g) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        // Double-tap a grip resets it to its default.
        if (e.timeStamp - lastTap.current < 320 && hover.current === g.id) {
          onParam(g.param, g.def);
          lastTap.current = 0;
          drag.current = null;
          redraw();
          return;
        }
        lastTap.current = e.timeStamp;
        // Grab-offset: keep (gripFraction − grabFraction) so the grip doesn't jump to the finger;
        // it then tracks the finger's fraction absolutely.
        drag.current = { kind: "grip", grip: g, offset: gripFrac(g, (params.current as Record<string, number>)[g.param]) - fracOf(pt.x, pt.y) };
        hover.current = g.id;
        redraw();
      }}
      onPointerMove={(e) => {
        const pt = localPt(e);
        const d = drag.current;
        if (d) {
          const c = ctxRef.current;
          if (d.kind === "ribbon") {
            const rect = { x: 0, y: c.ribbonY, w: c.w, h: c.ribbonH };
            const lo = params.current.lowCut;
            const hi = params.current.highCut;
            if (d.which === "hp") onParamRef.current("lowCut", dragHp(pt.x, rect, hi, RIBBON_RANGE));
            else if (d.which === "lp") onParamRef.current("highCut", dragLp(pt.x, rect, lo, RIBBON_RANGE));
            else {
              const [nLo, nHi] = dragBand(pt.x - d.lastX, rect, lo, hi, RIBBON_RANGE);
              d.lastX = pt.x;
              onParamRef.current("lowCut", nLo);
              onParamRef.current("highCut", nHi);
            }
          } else {
            const frac = fracOf(pt.x, pt.y) + d.offset;
            onParamRef.current(d.grip.param, gripParamAt(d.grip, frac));
          }
          return;
        }
        if (inRibbon(pt.y)) {
          const c = ctxRef.current;
          const grip = c.w < NARROW_PX ? RIBBON_GRIP_PX * 1.6 : RIBBON_GRIP_PX;
          const kind = hitFreqRibbon(pt.x, pt.y, { x: 0, y: c.ribbonY, w: c.w, h: c.ribbonH }, params.current.lowCut, params.current.highCut, grip);
          if (kind !== hover.current) {
            hover.current = kind;
            redraw();
          }
          return;
        }
        const g = nearest(pt.x, pt.y);
        const id = g?.id ?? null;
        if (id !== hover.current) {
          hover.current = id;
          redraw();
        }
      }}
      onPointerUp={(e) => {
        if (drag.current) {
          drag.current = null;
          redraw();
        }
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onContextMenu={(e) => {
        const pt = localPt(e);
        if (inRibbon(pt.y)) {
          e.preventDefault();
          onParam("lowCut", 20);
          onParam("highCut", 18000);
          redraw();
          return;
        }
        const g = nearest(pt.x, pt.y);
        if (g) {
          e.preventDefault();
          onParam(g.param, g.def);
          redraw();
        }
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

// accent is a resolved hex (#rrggbb / #rgb) or rgb()/rgba() string — wrap it with an alpha.
function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (c.length === 7) {
      r = parseInt(c.slice(1, 3), 16);
      g = parseInt(c.slice(3, 5), 16);
      b = parseInt(c.slice(5, 7), 16);
    } else if (c.length === 4) {
      r = parseInt(c[1] + c[1], 16);
      g = parseInt(c[2] + c[2], 16);
      b = parseInt(c[3] + c[3], 16);
    }
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(",").slice(0, 3).map((s) => s.trim());
    return `rgba(${parts.join(",")},${a})`;
  }
  return c;
}

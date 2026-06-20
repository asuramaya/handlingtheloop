import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";

// Reverb tail view — a full RADIAL display with a Pro-R-style decay-rate curve as its rim,
// AND a direct-control surface. Read the dome from the centre out:
//   • CENTRE = the source (a warm DRIVE glow); a dark inner disc = the PREDELAY gap.
//   • RADIUS outward = time → the diffuse fog dissipates as the tail decays.
//   • ANGLE around the circle = FREQUENCY (top = low, clockwise to high); the rim CURVE's
//     reach at each angle = how long that band rings. Animates only when something moves.
//
// DIRECT CONTROL — two grip kinds, both absolute (the grip tracks your finger along a radius,
// with a grab-offset so there's no jump), big hit targets, on fixed evenly-spaced spokes so
// nothing piles up:
//   • FEATURE grips sit ON the thing they control, so dragging moves that feature: DRIVE = the
//     core, PREDLY = the inner disc edge, DECAY = the bloom edge, SIZE = the boundary ring.
//   • VALUE grips ride a clean radial track: BRIGHT, WIDTH, and the LO/HI band CUTS (log Hz).
// shift-wheel on DECAY → CHAR, on WIDTH → RATE. wheel nudges a grip; dbl-click / right-click
// resets it. MIX·DUCK stay as cells beside the dome.

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
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const f2n = (hz: number) => clamp01(Math.log(clamp(hz, 20, 20000) / 20) / Math.log(1000)); // 20‥20k → 0..1 log
const TWO_PI = Math.PI * 2;
const WARM = "255,150,70"; // DRIVE glow colour

const GRAB_PX = 26; // pointer-to-grip hit radius (generous — the grips ARE the controls)
const NODE_R = 6.5; // grip dot radius
const T = -Math.PI / 2; // 12 o'clock
const Q = Math.PI / 2;

// The live dome geometry the grips measure against (set each draw, read by the handlers).
interface Ctx {
  base: number; // unscaled dome radius = min(w,h)*0.46
  R: number; // SIZE boundary radius
  r0: number; // PREDELAY inner-disc radius
  coreR: number; // DRIVE core radius
  fogR: number; // DECAY bloom radius
  duckPulse: number;
}

// A grip rides a fixed spoke (angle). A VALUE grip maps its param linearly (or log, for Hz)
// along a track between two fractions of `base`. A FEATURE grip instead sits on a live dome
// feature (`rad`) and inverts that feature's radius back to its param (`toParam`) — so the
// grip IS the feature and dragging moves it. `sec` is a shift-wheel secondary.
interface Grip {
  id: string;
  param: string;
  label: string;
  angle: number;
  min: number;
  max: number;
  def: number;
  fmt: (v: number) => string;
  rIn?: number; // VALUE track (fraction of base)
  rOut?: number;
  log?: boolean;
  feat?: { rad: (c: Ctx) => number; toParam: (r: number, c: Ctx) => number }; // FEATURE anchor
  sec?: { param: string; min: number; max: number };
}
const pct = (v: number) => `${Math.round(v * 100)}`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const ms = (v: number) => `${Math.round(v * 1000)}ms`;
const GRIPS: Grip[] = [
  // EVERY grip is the SAME radial control: a dot on a fixed spoke, dragged in/out along a
  // track (0.42 → 1.0 of the dome radius) — identical travel + feel for all of them. The
  // inner end is 0.42 (not 0) so a min-value grip (DRIVE 0, PREDLY ~0) lands on a clean ring
  // OUTSIDE the orange core instead of buried in it; the outer end reaches the boundary. The
  // dome's core / disc / bloom / boundary still grow live from the params as the readout.
  { id: "decay", param: "decay", label: "DECAY", angle: T, rIn: 0.42, rOut: 1.0, min: 0, max: 1, def: 0.5, fmt: pct, sec: { param: "character", min: 0, max: 1 } },
  { id: "size", param: "size", label: "SIZE", angle: T + Q / 2, rIn: 0.42, rOut: 1.0, min: 0, max: 1, def: 0.6, fmt: pct },
  { id: "highCut", param: "highCut", label: "HI CUT", angle: T + Q, rIn: 0.42, rOut: 1.0, min: 1000, max: 20000, def: 18000, log: true, fmt: hz },
  { id: "width", param: "width", label: "WIDTH", angle: T + Q * 1.5, rIn: 0.42, rOut: 1.0, min: 0, max: 1.5, def: 1, fmt: pct, sec: { param: "modRate", min: 0.02, max: 6 } },
  { id: "drive", param: "drive", label: "DRIVE", angle: T + Q * 2, rIn: 0.42, rOut: 1.0, min: 0, max: 1, def: 0, fmt: pct },
  { id: "bright", param: "brightness", label: "BRIGHT", angle: T + Q * 2.5, rIn: 0.42, rOut: 1.0, min: 0, max: 1, def: 0.6, fmt: pct },
  { id: "lowCut", param: "lowCut", label: "LO CUT", angle: T + Q * 3, rIn: 0.42, rOut: 1.0, min: 20, max: 2000, def: 20, log: true, fmt: hz },
  { id: "predelay", param: "predelay", label: "PREDLY", angle: T + Q * 3.5, rIn: 0.42, rOut: 1.0, min: 0, max: 0.2, def: 0.012, fmt: ms },
];
// VALUE grip: norm (0..1 along track) ⇄ param value.
const gripNorm = (g: Grip, v: number) => (g.log ? clamp01(Math.log(clamp(v, g.min, g.max) / g.min) / Math.log(g.max / g.min)) : clamp01((v - g.min) / (g.max - g.min)));
const gripVal = (g: Grip, n: number) => (g.log ? g.min * Math.pow(g.max / g.min, clamp01(n)) : g.min + clamp01(n) * (g.max - g.min));
// Where a grip sits (radius in px) for the current params, and the param a dragged radius maps to.
const gripRadius = (g: Grip, v: number, c: Ctx) => (g.feat ? g.feat.rad(c) : c.base * ((g.rIn ?? 0.3) + gripNorm(g, v) * ((g.rOut ?? 0.98) - (g.rIn ?? 0.3))));
const gripParamAt = (g: Grip, r: number, c: Ctx) => (g.feat ? g.feat.toParam(r, c) : gripVal(g, (r / c.base - (g.rIn ?? 0.3)) / ((g.rOut ?? 0.98) - (g.rIn ?? 0.3))));

interface Placed extends Grip {
  x: number;
  y: number;
  radius: number;
}

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

  // Live state the pointer/wheel handlers read (kept off the effect's closure).
  const params = useRef({ size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate });
  params.current = { size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate };
  const onParamRef = useRef(onParam);
  onParamRef.current = onParam;
  const center = useRef({ cx: 0, cy: 0 });
  const ctxRef = useRef<Ctx>({ base: 1, R: 1, r0: 0, coreR: 1, fogR: 1, duckPulse: 1 });
  const placed = useRef<Placed[]>([]);
  const hover = useRef<string | null>(null);
  const drag = useRef<{ grip: Grip; offset: number } | null>(null); // offset = gripRadius − grabRadius (no jump)
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
    const angOf = (fNorm: number) => -Math.PI / 2 + fNorm * TWO_PI; // top = low, clockwise

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

      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.46;
      center.current = { cx, cy };
      const sizeScale = 0.6 + clamp01(size) * 0.4;
      const R = base * sizeScale;
      const r0frac = 0.1 + clamp01(predelay / 0.2) * 0.22; // predelay gap (fraction of R)
      const r0 = R * r0frac;
      const span = R - r0;
      const elapsed = (now - start) / 1000;
      const phase = TWO_PI * modRate * elapsed;
      const reachBase = frozen ? 1 : 0.18 + clamp01(decay) * 0.82;
      const mixA = 0.32 + clamp01(mix) * 0.68;
      const dr = clamp01(drive);
      const duckPulse = duck > 0 ? 1 - clamp01(duck) * 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 2.4)) : 1;
      const loN = f2n(lowCut);
      const hiN = f2n(highCut);
      const coreR = Math.max(3, R * 0.14) * (1 + dr * 1.1) * duckPulse;
      const fogR = R * reachBase * duckPulse;
      ctxRef.current = { base, R, r0, coreR, fogR, duckPulse };

      // === LIVING ROOM FIELD — fills the wide panel's empty side bands with the reverb's
      //     energy dispersing into the room. Drawn BEHIND the dome (the central dome paints
      //     over the inner region, leaving this visible in the wings). A horizontal glow +
      //     reflection motes that fan OUTWARD (spread by WIDTH, reach/lifetime by DECAY,
      //     presence by MIX), breathing with DUCK and PULSING with the live wet signal. ===
      const energy = energyRef.current;
      const wing = w / 2 - R; // empty horizontal space beyond the dome boundary
      if (wing > 40) {
        // horizontal room glow — radial to the panel width; since the panel is wider than
        // tall it reads mostly in the L/R wings, barely top/bottom.
        const wingA = (0.05 + 0.06 * clamp01(mix)) * (0.55 + 0.45 * energy) * duckPulse;
        const wg = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, w * 0.62);
        wg.addColorStop(0, withAlpha(dr > 0 ? `rgb(${WARM})` : accent, wingA));
        wg.addColorStop(1, withAlpha(accent, 0));
        ctx.fillStyle = wg;
        ctx.fillRect(0, 0, w, h);

        // spawn reflection motes from the room boundary, fanning into the wings.
        spawnAcc.current += dt * (1.5 + energy * 16 + clamp01(decay) * 5) * (0.4 + clamp01(mix));
        const spread = 0.5 + clamp01(width / 1.5) * 1.4; // WIDTH → how far they reach sideways
        while (spawnAcc.current >= 1 && motes.current.length < 70) {
          spawnAcc.current -= 1;
          const dir = (now * 997 + motes.current.length) % 2 < 1 ? -1 : 1; // alternate-ish L/R
          const vj = (((now * 131 + motes.current.length * 53) % 100) / 100 - 0.5) * 0.5; // vert jitter
          const ang = (dir > 0 ? 0 : Math.PI) + vj; // mostly horizontal
          const speed = (38 + clamp01(decay) * 130) * (0.6 + energy * 0.8);
          const life = 0.5 + clamp01(decay) * 1.8;
          motes.current.push({ x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R, vx: Math.cos(ang) * speed * spread, vy: Math.sin(ang) * speed * 0.5, life, max: life, warm: dr > 0.2 && (now % 100) / 100 < dr });
        }
        // advance + draw motes (outward drift with air drag, fading over their life)
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
          const a = u * u * (0.32 + clamp01(mix) * 0.68) * (0.5 + 0.5 * energy) * duckPulse;
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
        motes.current.length = 0; // narrow panel — no wings, drop the field
      }

      const reachAt = (fNorm: number) => {
        const tilt = 1 - (1 - clamp01(brightness)) * fNorm * 0.85;
        const band = smooth((fNorm - loN) / 0.06) * smooth((hiN - fNorm) / 0.06);
        const skew = 1 + (width - 1) * 0.16 * Math.sin(fNorm * Math.PI);
        const wob = character > 0 ? character * 0.05 * Math.sin(fNorm * 8 - phase) : 0;
        return clamp01(r0frac + reachBase * tilt * band * skew * (1 - r0frac) + wob) * duckPulse;
      };

      // === diffuse BLOOM — radial fog, warmed by DRIVE, scaled by MIX + DUCK breathe ===
      const grad = ctx.createRadialGradient(cx, cy, r0 * 0.6, cx, cy, Math.max(r0 + 1, fogR));
      grad.addColorStop(0, dr > 0 ? `rgba(${WARM},${(0.34 + dr * 0.3) * mixA})` : withAlpha(accent, 0.4 * mixA));
      grad.addColorStop(0.5, withAlpha(accent, 0.14 * mixA));
      grad.addColorStop(1, withAlpha(accent, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(r0 + 1, fogR), 0, TWO_PI);
      ctx.fill();

      // drifting energy rings (outward = time), breathing with DUCK.
      const RINGS = 4;
      for (let i = 0; i < RINGS; i++) {
        const u = (elapsed * 0.16 + i / RINGS) % 1;
        const rr = r0 + u * (fogR - r0);
        const a = (frozen ? 0.2 : 0.24 * (1 - u)) * (0.5 + 0.5 * clamp01(decay)) * mixA;
        ctx.strokeStyle = withAlpha(accent, a);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, rr), 0, TWO_PI);
        ctx.stroke();
      }

      // === decay-rate CURVE (Pro-R, polar) — radius per angle = that band's decay ===
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const fNorm = i / 120;
        const r = r0 + reachAt(fNorm) * span;
        const a = angOf(fNorm);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
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

      // SIZE → faint room boundary.
      ctx.strokeStyle = withAlpha(accent, 0.1 + clamp01(size) * 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TWO_PI);
      ctx.stroke();

      // predelay inner disc (dark gap before the onset).
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.arc(cx, cy, r0, 0, TWO_PI);
      ctx.fill();

      // === DRIVE → a warm, swelling core glow at the source ===
      ctx.save();
      if (dr > 0) {
        ctx.shadowColor = `rgba(${WARM},0.95)`;
        ctx.shadowBlur = 8 + dr * 26;
        ctx.fillStyle = `rgba(${WARM},${0.55 + dr * 0.4})`;
      } else {
        ctx.fillStyle = withAlpha(accent, 0.85);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TWO_PI);
      ctx.fill();
      ctx.restore();

      // === place + draw the GRIPS ===
      const c = ctxRef.current;
      placed.current = GRIPS.map((g) => {
        const radius = gripRadius(g, (params.current as Record<string, number>)[g.param], c);
        return { ...g, radius, x: cx + Math.cos(g.angle) * radius, y: cy + Math.sin(g.angle) * radius };
      });

      // faint radial guides (so the in/out drag axis is discoverable), then the dots.
      for (const g of placed.current) {
        const hot = drag.current?.grip.id === g.id || hover.current === g.id;
        const ix = cx + Math.cos(g.angle) * base * 0.08;
        const iy = cy + Math.sin(g.angle) * base * 0.08;
        const ox = cx + Math.cos(g.angle) * base * (g.feat ? 1.05 : g.rOut ?? 0.98);
        const oy = cy + Math.sin(g.angle) * base * (g.feat ? 1.05 : g.rOut ?? 0.98);
        ctx.strokeStyle = withAlpha(accent, hot ? 0.3 : 0.1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ix, iy);
        ctx.lineTo(ox, oy);
        ctx.stroke();
      }
      for (const g of placed.current) {
        const hot = drag.current?.grip.id === g.id || hover.current === g.id;
        ctx.beginPath();
        ctx.arc(g.x, g.y, hot ? NODE_R + 2.5 : NODE_R, 0, TWO_PI);
        ctx.fillStyle = hot ? "#fff" : withAlpha(accent, 0.95);
        ctx.shadowColor = accent;
        ctx.shadowBlur = hot ? 12 : 5;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = withAlpha(accent, hot ? 1 : 0.55);
        ctx.stroke();
      }

      // active/hover grip readout — its label + value, top-left.
      const act = drag.current ? drag.current.grip : hover.current ? GRIPS.find((g) => g.id === hover.current) ?? null : null;
      if (act) {
        const v = (params.current as Record<string, number>)[act.param];
        ctx.fillStyle = accent;
        ctx.font = "700 10px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`${act.label} ${act.fmt(v)}`, 7, 12);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.font = "8px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("LOW", cx, 9);
        ctx.textAlign = "left";
      }
      if (frozen) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(elapsed * 3));
        ctx.fillText("❄ FROZEN", w - 56, 11);
        ctx.globalAlpha = 1;
      }
    };
    drawRef.current = draw;

    const animated = true; // always alive — the room field drifts at rest + reacts to the wet signal
    let raf = 0;
    if (animated) {
      const loop = (now: number) => {
        draw(now);
        raf = window.requestAnimationFrame(loop);
      };
      raf = window.requestAnimationFrame(loop);
    } else {
      draw(start);
    }
    const ro = new ResizeObserver(() => draw(nowRef.current || start));
    ro.observe(wrap);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [size, decay, brightness, predelay, width, lowCut, highCut, mix, drive, duck, character, modRate, frozen, accent]);

  // --- direct control: hit-test grips, map drag → param (absolute along the spoke radius) ---
  const localPt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const radOf = (x: number, y: number) => Math.hypot(x - center.current.cx, y - center.current.cy);
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
  const redraw = () => drawRef.current(nowRef.current || window.performance.now());

  // Native, non-passive wheel — nudge the hovered grip (shift = its secondary), like ValueCell.
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const pt = localPt(e);
      const g = nearest(pt.x, pt.y) ?? (hover.current ? placed.current.find((p) => p.id === hover.current) ?? null : null);
      if (!g) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const tgt = e.shiftKey && g.sec ? g.sec : { param: g.param, min: g.min, max: g.max };
      const cur = (params.current as Record<string, number>)[tgt.param];
      onParamRef.current(tgt.param, clamp(cur + dir * (tgt.max - tgt.min) / 40, tgt.min, tgt.max));
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
        // Grab-offset: keep (gripRadius − grabRadius) so the grip doesn't jump to the finger;
        // it then tracks the finger's radius absolutely.
        drag.current = { grip: g, offset: g.radius - radOf(pt.x, pt.y) };
        hover.current = g.id;
        redraw();
      }}
      onPointerMove={(e) => {
        const pt = localPt(e);
        const d = drag.current;
        if (d) {
          const r = radOf(pt.x, pt.y) + d.offset;
          onParam(d.grip.param, gripParamAt(d.grip, r, ctxRef.current));
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

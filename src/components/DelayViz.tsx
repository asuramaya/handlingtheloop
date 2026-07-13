import { useEffect, useRef } from "react";

// The Delay's instrument — an echo-tap timeline you PLAY, not a picture of one.
//
// It used to be read-only, which made the panel absurd: a rack of number cells sitting under a
// canvas that already drew every one of those same params. Now the canvas IS the control surface,
// the way the EQ's curve is:
//
//   • GRAB A TAP        → drag sideways = TIME (the tap you're holding follows your cursor, so
//                         grabbing the 3rd echo and pulling right sets time to a third of where
//                         you drop it). With SYNC lit it snaps to the note grid.
//                       → drag up/down = FEEDBACK, on a MONOTONIC fader: the bottom of the tap's
//                         swing is 0%, the top is 100%, and every tap turns the same way. Solved
//                         so THAT tap lands at that height (fb = amp^(1/n)), which is why a far
//                         tap gives fine control of the tail — the further out, the more the
//                         gesture is about the tail and the less about the first hit.
//   • THE FILTER RIBBON → the echoes' tone window on a log-freq scale. Drag an EDGE to move one
//                         cut; drag the BODY to sweep the whole band. That body-drag is what the
//                         old LINK chip did, so LINK is deleted, not redesigned — it only ever
//                         existed because HP and LP were two separate cells.
//   • THE WAVE          → the wobble. DEPTH and RATE were never two knobs: depth without rate is
//                         silent, rate without depth is inaudible, and neither half means anything
//                         alone. That's the tell that they're ONE control wearing two costumes. So
//                         it's one gesture on the shape the wobble actually makes — up/down is how
//                         deep (the crest follows your finger), sideways STRETCHES it (right is
//                         slower, left faster, log-scaled so every octave feels the same width).
//                         ★ At depth 0 the wave is flat — and a flat wave is exactly the centre
//                         line, which is already drawn. So the resting wobble isn't a ghost with
//                         nothing to grab: it IS that line. Pull it off centre and the wobble is
//                         born. That's what keeps this a control instead of a decoration you can
//                         happen to poke.
//
// Right-click resets whatever is under the cursor — a gesture you can't undo isn't a control, it's
// a trap. Still drawn, still read-only (they keep their cells): DUCK as a sidechain dip on the
// early taps, WIDTH as an L/R split, DRIVE as a warm glow.

interface DelayVizProps {
  time: number; // seconds between taps
  feedback: number; // 0..1 decay per tap
  mix: number; // 0..1 — overall wet, dims the taps
  pingpong: boolean;
  frozen: boolean;
  bpm: number | null;
  accent: string;
  hp: number; // feedback band-pass low-cut (Hz)
  lp: number; // feedback band-pass high-cut (Hz)
  modDepth: number; // LFO → delay-time depth (0..0.012 s)
  modRate: number; // LFO rate (Hz)
  drive: number; // analog saturation (0..1)
  duck: number; // sidechain ducking (0..1)
  width: number; // stereo L/R time spread (0..1)
  // TIME left the cell row, so the viz has to SAY it — and it has to say it from the value it just
  // painted, not from a string React hands back a render later (mid-drag that lags a division
  // behind the tap you're holding). So: the grid, and the viz names the note itself.
  snapBeats?: number[]; // the note divisions TIME snaps to (absent when free-running)
  snapLabels?: string[]; // …and their names, index-matched
  modSnapBeats?: number[]; // the wobble's ladder — beats per LFO cycle
  modSnapLabels?: string[];
  // ★ EVERY HANDLER RETURNS WHAT THE DEVICE ACTUALLY COMMITTED, and the canvas mirrors THAT — not
  // what the pointer asked for. When a value is quantised (TIME snaps to the note grid) or clamped,
  // the request and the commit are DIFFERENT NUMBERS. Mirroring the request paints the tap under
  // your finger; the next React render then overwrites the mirror with the committed value and the
  // tap jumps back to the grid. The surface alternates between the lie and the truth on every
  // render — and while the deck is PLAYING the transport forces extra renders, so it alternates
  // faster. That is the chop. (The filter never chopped because it's continuous: request == commit,
  // so there was nothing to alternate between.)
  onTime: (seconds: number) => number; // → the seconds it LOCKED to (snapped to the note grid)
  onFeedback: (v: number) => number;
  onFilters: (hp: number, lp: number) => [number, number];
  onMod: (depth: number, rate: number) => [number, number]; // the wobble — one gesture, two axes
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const MOD_MAX = 0.012; // matches DELAY modDepth cell max — normalises depth to 0..1
const FB_MAX = 0.95;
const MAX_TIME = 2; // the delay line's ceiling (DelayFx clamps here too)
const HP_MIN = 20;
const LP_MAX = 18000;
const BAND_MIN_RATIO = 1.35; // the cuts may not cross (or meet) — a band needs to stay a band
const RATE_MIN = 0.02;
const RATE_MAX = 8;
// The wave's height at FULL depth, as a fraction of the timeline half — and therefore ALSO the
// drag distance that reaches full depth, because the crest follows your finger. At 0.22 the whole
// range lived in ~21px of travel: the wobble slammed to 100% the moment you touched it.
const LFO_AMP_FRAC = 0.38;
const NARROW_PX = 260; // below this the deck is a phone column, not a desktop panel
const GRIP_PX = 10; // how close counts as "on" a filter edge
const TAP_GRIP = 16; // ...and on a tap. Wider: the taps are a 3px bar and sit ~150px apart, so
// there's nothing to hit by accident, and a stingy grip just makes the surface feel dead.
const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);

// log-frequency ↔ x, 20 Hz‥20 kHz across the width
const fToX = (f: number, w: number) => (Math.log(clamp(f, 20, 20000) / 20) / Math.log(1000)) * w;
const xToF = (x: number, w: number) => 20 * Math.exp((clamp(x, 0, w) / w) * Math.log(1000));

type Grab =
  | { kind: "tap"; n: number; ghostX: number; startY: number; startFb: number }
  | { kind: "hp" }
  | { kind: "lp" }
  | { kind: "band"; lastX: number }
  | { kind: "lfo"; startX: number; startRate: number };

export function DelayViz({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod }: DelayVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab | null>(null);
  const hover = useRef<string>(""); // which handle the cursor is over → cursor shape + highlight
  const kickRef = useRef<() => void>(() => {}); // request one repaint (the loop idles when nothing moves)

  // The draw loop reads props through a ref so the pointer handlers (attached once) and the
  // renderer always agree on the same values.
  const p = useRef({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod });
  p.current = { time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod };

  // Geometry, shared by the renderer and the hit-tests — one source of truth, or the thing you
  // grab won't be the thing you see.
  // The ribbon needs to be a THUMB target on a phone, not a hairline: a 20px strip is a miss
  // waiting to happen. It costs a little of the timeline's height, which the timeline can spare.
  const geom = (h: number, w = 999) => {
    const ribbonH = w < NARROW_PX ? Math.max(26, Math.round(h * 0.22)) : Math.max(20, Math.round(h * 0.2));
    const top = ribbonH + 3;
    const midY = top + (h - top) / 2;
    return { ribbonH, top, midY, maxBar: (h - top) * 0.42 };
  };
  // ★ A STABLE TIME AXIS — a ruler, not a rubber band.
  //
  // It used to be derived from the value it was displaying: max(beat·4, time·4.5, 0.4). Once the
  // time term won, the window grew WITH the time, so tap 1 sat at t/(4.5·t) = 22% of the width
  // FOREVER. A fixed point. You could drag a tap to 85%, and on release the axis rescaled under
  // it and hauled it back to 22% — measured: dragging to 25/45/65/85% landed at 21% every time.
  // That is the surface literally fighting you, and no amount of drag smoothing would have fixed
  // it, because the ruler was made of the thing being measured.
  //
  // Now: two bars when we know the tempo, else the delay's full range. The taps move; the ruler
  // never does.
  //
  // ★ AND IT'S NARROWER ON A NARROW DECK. On a phone this canvas is ~172px, and at 1/8 in a
  // two-bar window the taps land ~11px apart — which forces the grip down to ~5px (it can never
  // exceed half the gap, or you grab the wrong echo). A 5px target is not a thumb target: the
  // whole instrument was unusable on touch. The answer isn't a bigger grip, it's FEWER TAPS ON
  // SCREEN — one bar instead of two doubles every gap, and doubles every grip with it. You lose
  // nothing but empty tail you couldn't see anyway.
  const windowOf = (beat: number, w: number) => {
    const bars = w < NARROW_PX ? 4 : 8; // beats of timeline
    return beat > 0 ? beat * bars : MAX_TIME * (w < NARROW_PX ? 0.6 : 1.2);
  };

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

    const draw = (now: number) => {
      const { w, h, dpr } = sizeCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const s = p.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const round = (n: number) => Math.round(n);
      const t = Math.max(0.001, s.time);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const g = grab.current;
      const windowSec = windowOf(beat, w);
      const xOf = (sec: number) => (sec / windowSec) * w;
      const { ribbonH, top, midY, maxBar } = geom(h, w);
      const elapsed = (now - start) / 1000;
      const accent = s.accent;

      // === THE FILTER RIBBON — the echoes' tone window, and a control. Edges are grips; the body
      // sweeps the band. ===
      const lo = fToX(s.hp, w);
      const hi = fToX(s.lp, w);
      const rH = ribbonH - 4;
      const bandHot = hover.current === "band" || grab.current?.kind === "band";
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, 0, w, rH);

      // A SPECTRUM RULER — decade ticks only, NO text. The strip is ~20px tall and the band already
      // labels its own two edges in Hz; adding 100/1k/10k captions on top of that just collided
      // with them. The ticks give the scale, the edges give the numbers, and neither repeats the
      // other.
      ctx.strokeStyle = "rgba(255,255,255,0.09)";
      ctx.lineWidth = 1;
      for (const f of [100, 1000, 10000]) {
        const x = Math.round(fToX(f, w)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, rH);
        ctx.stroke();
      }

      // ★ THE BAND IS DRAWN AS THE FILTER IT IS — a plateau with SLOPED SHOULDERS, not a rectangle.
      // A rectangle reads as a progress bar (a quantity), and the eye asks "how full is it?". A
      // shape with skirts reads as a response curve (a shape), and the eye asks "what gets through?"
      // — which is the actual question. The shoulders lean the way the real filters roll off.
      const skirt = Math.min(26, Math.max(6, (hi - lo) * 0.18));
      ctx.beginPath();
      ctx.moveTo(Math.max(0, lo - skirt), rH);
      ctx.lineTo(lo, 2);
      ctx.lineTo(hi, 2);
      ctx.lineTo(Math.min(w, hi + skirt), rH);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = bandHot ? 0.3 : 0.2;
      ctx.fill();
      ctx.globalAlpha = bandHot ? 0.95 : 0.6;
      ctx.strokeStyle = accent;
      ctx.lineWidth = bandHot ? 2 : 1.25;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // The grips are HANDLES, with a grab-notch — not hairlines. You should be able to see what to
      // take hold of without discovering it with the mouse.
      for (const [x, id] of [
        [lo, "hp"],
        [hi, "lp"],
      ] as [number, string][]) {
        const on = hover.current === id || grab.current?.kind === id;
        const gx = round(x);
        ctx.fillStyle = accent;
        ctx.globalAlpha = on ? 1 : 0.85;
        ctx.fillRect(gx - 1, 0, 3, rH);
        // the notch: three ribs, the universal "grab me"
        ctx.globalAlpha = on ? 0.9 : 0.55;
        ctx.fillStyle = "#000";
        for (let k = -1; k <= 1; k++) ctx.fillRect(gx, rH / 2 + k * 3, 1, 1);
        ctx.globalAlpha = 1;
      }

      // The numbers live AT the grips they belong to, not merged into one label in the middle —
      // so each cut says its own value, which is what you're actually setting.
      ctx.font = "700 8.5px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.95;
      ctx.textAlign = "right";
      ctx.fillText(fmtF(s.hp), Math.max(20, lo - 5), rH / 2);
      ctx.textAlign = "left";
      ctx.fillText(fmtF(s.lp), Math.min(w - 20, hi + 5), rH / 2);
      ctx.globalAlpha = 1;

      // beat grid + centre line (in the timeline half only)
      if (beat > 0) {
        ctx.lineWidth = 1;
        for (let sec = beat, k = 1; sec < windowSec; sec += beat, k++) {
          ctx.strokeStyle = k % 4 === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
          const x = Math.round(xOf(sec)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY + 0.5);
      ctx.lineTo(w, midY + 0.5);
      ctx.stroke();

      // === THE WOBBLE — DEPTH × RATE, and it is ONE OBJECT, not two knobs. Neither half means
      // anything alone: depth without rate is silent, rate without depth is inaudible. So it's one
      // gesture on the shape the wobble actually makes. Grab the wave: UP/DOWN is how deep, and
      // dragging sideways STRETCHES it — right is slower, left is faster, and the wavelength
      // follows your hand.
      //
      // ★ At depth 0 the wave is FLAT — and a flat wave is exactly the centre line, which is
      // already drawn. So the resting wobble isn't a ghost with nothing to grab: it's that line.
      // Pull the line off centre and the wobble is born. That's what makes this a control and not
      // a decoration you can happen to poke.
      const modN = clamp01(s.modDepth / MOD_MAX);
      const phase = 2 * Math.PI * s.modRate * elapsed;
      const lfoNow = modN * Math.sin(-phase);
      const lfoHot = hover.current === "lfo" || grab.current?.kind === "lfo";
      if (modN > 0.001 && s.modRate > 0) {
        const lfoAmp = modN * (h - top) * LFO_AMP_FRAC;
        const cycles = Math.max(0.5, s.modRate * windowSec);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
          const y = midY + lfoAmp * Math.sin((2 * Math.PI * cycles * x) / w - phase);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = lfoHot ? 0.95 : 0.5;
        ctx.lineWidth = lfoHot ? 2.5 : 1.5;
        ctx.shadowColor = accent;
        ctx.shadowBlur = lfoHot ? 10 : 6;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      } else if (lfoHot) {
        // At rest: light the centre line, so the thing you're about to grab announces itself.
        ctx.beginPath();
        ctx.moveTo(0, midY + 0.5);
        ctx.lineTo(w, midY + 0.5);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 2;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
      if (lfoHot) {
        ctx.font = "800 9px ui-monospace, monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.95;
        let rateLabel = `${s.modRate.toFixed(2)} Hz`;
        if (s.modSnapBeats?.length && s.modSnapLabels?.length && beat > 0) {
          const cyc = 1 / Math.max(1e-4, s.modRate) / beat; // beats per LFO cycle
          let bi = 0;
          let bd = Infinity;
          s.modSnapBeats.forEach((bv, i) => {
            const d = Math.abs(Math.log(bv / Math.max(1e-4, cyc)));
            if (d < bd) {
              bd = d;
              bi = i;
            }
          });
          rateLabel = s.modSnapLabels[bi] ?? rateLabel;
        }
        ctx.fillText(`WOBBLE  ${Math.round(modN * 100)}%  ·  ${rateLabel}`, w - 6, top + 3);
        ctx.globalAlpha = 1;
      }

      // === THE TAPS ===
      const wet = 0.35 + 0.65 * clamp01(s.mix);
      const modShift = lfoNow * 8;
      const widthOff = clamp01(s.width) * 7;
      const duckTau = (beat > 0 ? beat : 0.5) * 0.5;
      const duckGain = (sec: number) => 1 - clamp01(s.duck) * Math.exp(-sec / duckTau);
      const barW = 3;
      const held = g && g.kind === "tap" ? g.n : -1;
      const tap = (x: number, amp: number, side: "up" | "down", alpha: number, lit: boolean) => {
        const bh = Math.max(1, maxBar * amp);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = lit ? "#fff" : accent;
        const bw = lit ? barW + 2 : barW;
        if (side === "up") ctx.fillRect(round(x - bw / 2), round(midY - bh), bw, round(bh));
        else ctx.fillRect(round(x - bw / 2), round(midY), bw, round(bh));
        ctx.globalAlpha = 1;
      };

      // the dry hit at t=0 — the source, not an echo. Never grabbable.
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(1, round(midY - maxBar), barW, round(maxBar * 2));
      ctx.globalAlpha = 1;

      // THE MAGNET, shown only while you're dragging a tap. TIME snaps to note divisions, so the
      // tap jumps from one to the next — and an unexplained jump reads as jitter, as the surface
      // misbehaving. Draw the targets and the same jump reads as magnetism, which is what it is.
      if (g && g.kind === "tap" && beat > 0 && s.snapBeats?.length) {
        // The rungs. The one we're LOCKED to burns bright; the rest are faint. A lock you can see
        // is a magnet; a lock you can't see is the surface disobeying you.
        const lockedSec = t * (g.n + 1);
        let lit = -1;
        let bd = Infinity;
        s.snapBeats.forEach((b, i) => {
          const d = Math.abs(b * beat * (g.n + 1) - lockedSec);
          if (d < bd) {
            bd = d;
            lit = i;
          }
        });
        s.snapBeats.forEach((b, i) => {
          const x = Math.round(xOf(b * beat * (g.n + 1))) + 0.5;
          if (x > w) return;
          ctx.strokeStyle = accent;
          ctx.globalAlpha = i === lit ? 0.9 : 0.2;
          ctx.lineWidth = i === lit ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(x, midY - maxBar - 4);
          ctx.lineTo(x, midY + maxBar + 4);
          ctx.stroke();
        });
        // THE GHOST — where your finger actually is. The tap can't follow it (the value is
        // quantised; there is no in-between to move to), so instead of pretending, SHOW the pull.
        // The distance between the ghost and the lit rung IS the magnet, made visible.
        ctx.strokeStyle = "#fff";
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(g.ghostX) + 0.5, midY - maxBar - 6);
        ctx.lineTo(Math.round(g.ghostX) + 0.5, midY + maxBar + 6);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // THE DECAY ENVELOPE — the tail, drawn as a curve through the tap tips. Without it the tail
      // is a row of ever-shorter bars fading to nothing, so "grab the tail and pull it up" means
      // aiming at a 2px stub you can barely see. The curve shows you where the tail IS.
      if (!s.frozen) {
        ctx.beginPath();
        for (let n = 0; n < 64; n++) {
          const ts = (n + 1) * t;
          if (ts > windowSec) break;
          const a = Math.pow(Math.max(0, Math.min(0.999, s.feedback)), n) * duckGain(ts);
          const x = xOf(ts);
          const y = midY - maxBar * a;
          n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.3;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      ctx.shadowColor = "rgba(255,170,90,0.9)";
      ctx.shadowBlur = clamp01(s.drive) * 8;
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        const base = s.frozen ? 1 : Math.pow(Math.max(0, Math.min(0.999, s.feedback)), n);
        if (!s.frozen && base < 0.02) break;
        const amp = base * duckGain(ts);
        const where = s.pingpong ? (n % 2 === 0 ? "up" : "down") : "both";
        const x = xOf(ts) + modShift;
        const a = 0.55 + 0.45 * amp * wet;
        const lit = n === held || hover.current === `tap${n}`;
        if (where === "up" || where === "both") tap(x - (where === "both" ? widthOff : 0), amp, "up", a, lit);
        if (where === "down" || where === "both") tap(x + (where === "both" ? widthOff : 0), amp, "down", a, lit);
      }
      ctx.shadowBlur = 0;

      // TIME and FEEDBACK left the cell row — so the viz has to SAY them. Bottom-left, quiet.
      ctx.font = "800 9.5px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.9;
      // Name the note from the time we just drew — never from a prop that arrives a render late.
      let label = `${Math.round(t * 1000)}ms`;
      if (s.snapBeats?.length && s.snapLabels?.length && beat > 0) {
        const beats = t / beat;
        let bi = 0;
        let bd = Infinity;
        s.snapBeats.forEach((bv, i) => {
          const d = Math.abs(Math.log(bv / Math.max(1e-4, beats)));
          if (d < bd) {
            bd = d;
            bi = i;
          }
        });
        label = s.snapLabels[bi] ?? label;
      }
      ctx.fillText(`${label}  ·  ${Math.round(clamp01(s.feedback) * 100)}%`, 5, h - 3);
      ctx.globalAlpha = 1;
    };

    // Redraw on demand (a drag) as well as on the LFO's own clock.
    let raf = 0;
    let alive = true;
    const loop = (now: number) => {
      if (!alive) return;
      draw(now);
      const animated = clamp01(p.current.modDepth / MOD_MAX) > 0.001 && p.current.modRate > 0;
      raf = animated || grab.current ? window.requestAnimationFrame(loop) : 0;
    };
    const kick = () => {
      if (!raf && alive) raf = window.requestAnimationFrame(loop);
    };
    kickRef.current = kick;
    kick();

    // --- hit-testing + gestures -------------------------------------------------------------
    const hitAt = (px: number, py: number): { kind: string; n?: number } | null => {
      const w = lastW;
      const h = lastH;
      const s = p.current;
      const { ribbonH, top } = geom(h, w);
      if (py <= ribbonH) {
        const lo = fToX(s.hp, w);
        const hi = fToX(s.lp, w);
        const grip = w < NARROW_PX ? GRIP_PX * 1.6 : GRIP_PX; // a thumb is not a mouse
        if (Math.abs(px - lo) <= grip) return { kind: "hp" };
        if (Math.abs(px - hi) <= grip) return { kind: "lp" };
        if (px > lo && px < hi) return { kind: "band" };
        // NO DEAD ZONE. Outside the band, the nearer cut jumps to where you pressed — the whole
        // ribbon is live. A strip that ignores you over most of its width reads as broken.
        return { kind: px < lo ? "hp" : "lp" };
      }
      if (py < top) return null;
      const t = Math.max(0.001, s.time);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const windowSec = windowOf(beat, w);
      let best = -1;
      // The grip can never be wider than half the gap to the next tap, or neighbouring grips
      // overlap and you grab the wrong echo. At 1/16 in a two-bar window the taps are ~24px apart.
      let bestD = Math.min(TAP_GRIP, Math.max(4, ((t / windowSec) * w) / 2));
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        // Only grab a tap you can SEE. An invisible one (decayed past the draw threshold) offered
        // absurd leverage — fb = amp^(1/n) with a big n turns a 2px nudge into a jump to 95%.
        const base = s.frozen ? 1 : Math.pow(Math.max(0, Math.min(0.999, s.feedback)), n);
        if (!s.frozen && base < 0.02) break;
        const d = Math.abs(px - (ts / windowSec) * w);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best >= 0) return { kind: "tap", n: best }; // a tap always wins — it's the primary gesture
      // THE WOBBLE: anywhere on the wave, between the taps. At depth 0 the wave IS the centre
      // line, so there's always something to grab — the resting wobble is never a ghost.
      const { midY: my, top: tp } = geom(h, w);
      const modN = clamp01(s.modDepth / MOD_MAX);
      const lfoAmp = modN * (h - tp) * LFO_AMP_FRAC;
      // Hit-test the BAND the wave sweeps, not one frozen phase of it — the wave is scrolling, so
      // testing the instantaneous curve would move the target out from under a stationary cursor
      // sixty times a second. Anywhere within its swing counts as "on the wave".
      const reach = Math.max(GRIP_PX, lfoAmp + GRIP_PX);
      return Math.abs(py - my) <= reach ? { kind: "lfo" } : null;
    };

    // ★ Paint from what we just computed — never wait for a React round-trip. The handlers push
    // the new value into the device AND into `p.current`, so the very next frame draws the gesture
    // that produced it. Before, the canvas only learned its own values when React re-rendered and
    // reassigned the props mirror: it was always at least a render behind its own input, and any
    // batching or throttling of that render read as a dead surface. (The next real render
    // overwrites the mirror with the device's own values, which agree — so this is a lead, not a
    // lie.)
    const setFilters = (hp: number, lp: number) => {
      const [chp, clp] = p.current.onFilters(hp, lp);
      p.current.hp = chp;
      p.current.lp = clp;
    };
    const setTime = (sec: number) => {
      p.current.time = p.current.onTime(sec); // the LOCKED seconds, not the requested ones
    };
    const setFeedback = (v: number) => {
      p.current.feedback = p.current.onFeedback(v);
    };
    const setMod = (depth: number, rate: number) => {
      const [cd, cr] = p.current.onMod(depth, rate);
      p.current.modDepth = cd;
      p.current.modRate = cr;
    };

    const apply = (px: number, py: number) => {
      const g = grab.current;
      if (!g) return;
      const w = lastW;
      const h = lastH;
      const s = p.current;
      if (g.kind === "hp" || g.kind === "lp") {
        const f = xToF(px, w);
        // The cuts may not cross: a band that isn't a band is just a mute.
        if (g.kind === "hp") setFilters(clamp(f, HP_MIN, s.lp / BAND_MIN_RATIO), s.lp);
        else setFilters(s.hp, clamp(f, s.hp * BAND_MIN_RATIO, LP_MAX));
        return;
      }
      if (g.kind === "band") {
        // Sweep BOTH by the same log-distance — the band keeps its width. (This is the old LINK.)
        // At a rail, SLIDE the band along it rather than freezing: a hard stop reads as "broken",
        // and the whole point of the body-drag is that the band's width survives the sweep.
        const dLog = ((px - g.lastX) / w) * Math.log(1000);
        g.lastX = px;
        const ratio = s.lp / s.hp;
        let nHp = clamp(s.hp * Math.exp(dLog), HP_MIN, LP_MAX / ratio);
        const nLp = clamp(nHp * ratio, HP_MIN * ratio, LP_MAX);
        nHp = nLp / ratio;
        setFilters(nHp, nLp);
        return;
      }
      if (g.kind === "lfo") {
        // DEPTH is absolute: the wave's height follows your finger off the centre line.
        const { midY, top } = geom(h, w);
        const full = Math.max(1, (h - top) * LFO_AMP_FRAC);
        const depth = clamp01(Math.abs(py - midY) / full) * MOD_MAX;
        // RATE is a STRETCH, and stretches are relative: drag right and the wave lengthens under
        // your hand (slower), left and it compresses (faster). Log-scaled, so one full-width drag
        // spans the whole 0.02‥8 Hz range and every octave of it feels the same width.
        const span = Math.log(RATE_MAX / RATE_MIN);
        const rate = clamp(g.startRate * Math.exp((-(px - g.startX) / w) * span), RATE_MIN, RATE_MAX);
        setMod(depth, rate);
        return;
      }
      // A TAP: X = time (this tap follows the cursor), Y = feedback (this tap lands at this height).
      g.ghostX = px; // where the FINGER is, as distinct from where the value LOCKED
      const { midY, maxBar } = geom(h, w);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const secAt = (clamp(px, 1, w) / w) * windowOf(beat, w);
      setTime(clamp(secAt / (g.n + 1), 0.02, MAX_TIME));
      // ★ THE VERTICAL LAW IS MONOTONIC — the bottom of a tap's swing is 0%, the top is 100%.
      // It used to be |py − midY| / maxBar: the DISTANCE from the centre line. That made the CENTRE
      // 0% and BOTH the top and the bottom 100% — a bipolar law on a control with no negative half.
      // Nothing said which way was "more", and half the travel mirrored the other half.
      const swing = Math.max(1, 2 * maxBar); // the full drawn height of a tap, bottom tip to top tip
      if (g.n >= 1) {
        // amp = fb^n  ⇒  fb = amp^(1/n): solve for the tap you're actually HOLDING, so it lands
        // under your finger. Absolute, and jump-free by construction — a tap's tip already sits at
        // its own value, so grabbing it by the tip moves nothing.
        const amp = clamp01((midY + maxBar - py) / swing);
        setFeedback(clamp(Math.pow(Math.max(amp, 1e-4), 1 / g.n), 0, FB_MAX));
        return;
      }
      // ★ THE FIRST ECHO IS PINNED AT UNITY by the topology — out = x(t−T) + fb·out(t−T) — so fb⁰=1
      // whatever fb is, and its HEIGHT cannot encode the tail. That was taken as a reason to make it
      // the one bar you CAN'T set the tail with, which is backwards: it's the biggest, nearest,
      // loudest bar on the surface, so it's the one a hand reaches for first.
      //
      // It just can't be ABSOLUTE. A full-height bar that doesn't stand for its value means grabbing
      // it anywhere near the top would slam feedback to the rail — you'd click the fattest thing on
      // screen and the delay would run away. So this one drag is RELATIVE: it starts from wherever
      // the tail already is and moves with your hand, at exactly the sensitivity of the taps beside
      // it (a full swing = the full 0‥100 range). The bar can't follow you, but the tail and the
      // readout do, and those are what the gesture is actually about.
      setFeedback(clamp(g.startFb + (g.startY - py) / swing, 0, FB_MAX));
    };

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { px, py } = local(e);
      const hit = hitAt(px, py);
      if (!hit) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (hit.kind === "tap") grab.current = { kind: "tap", n: hit.n!, ghostX: px, startY: py, startFb: p.current.feedback };
      else if (hit.kind === "band") grab.current = { kind: "band", lastX: px };
      else if (hit.kind === "lfo") grab.current = { kind: "lfo", startX: px, startRate: p.current.modRate };
      else grab.current = hit.kind === "hp" ? { kind: "hp" } : { kind: "lp" };
      apply(px, py);
      kick();
    };
    const onMove = (e: PointerEvent) => {
      const { px, py } = local(e);
      if (grab.current) {
        apply(px, py);
        return;
      }
      const hit = hitAt(px, py);
      const id = !hit ? "" : hit.kind === "tap" ? `tap${hit.n}` : hit.kind;
      if (id !== hover.current) {
        hover.current = id;
        canvas.style.cursor = !hit ? "default" : hit.kind === "band" ? "grab" : hit.kind === "tap" ? "move" : hit.kind === "lfo" ? "crosshair" : "ew-resize";
        kick();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!grab.current) return;
      grab.current = null;
      canvas.releasePointerCapture?.(e.pointerId);
      kick();
    };
    // A gesture you can't undo isn't a control, it's a trap. Right-click resets whatever's under
    // the cursor — the same contract the EQ's nodes already have.
    const onContext = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = hitAt(e.clientX - r.left, e.clientY - r.top);
      if (!hit) return;
      e.preventDefault();
      if (hit.kind === "lfo") setMod(0, 0.5); // still, again
      else if (hit.kind === "tap") setFeedback(0.38);
      else setFilters(120, 6500); // the band, wide open again
      kick();
    };
    const onLeave = () => {
      if (grab.current || !hover.current) return;
      hover.current = "";
      canvas.style.cursor = "default";
      kick();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("contextmenu", onContext);
    const ro = new ResizeObserver(kick);
    ro.observe(wrap);
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("contextmenu", onContext);
      ro.disconnect();
    };
    // Attached ONCE — every live value is read through `p.current` inside the handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A prop changed → ask for ONE repaint. The loop only self-schedules while the LFO is running
  // or a drag is live, so an idle delay costs no frames.
  useEffect(() => {
    kickRef.current();
  });

  return (
    <div className="dly-viz" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

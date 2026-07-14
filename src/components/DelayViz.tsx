import { useEffect, useRef } from "react";

// The Delay's instrument — an echo-tap timeline you PLAY, not a picture of one.
//
// It used to be read-only, which made the panel absurd: a rack of number cells sitting under a
// canvas that already drew every one of those same params. Now the canvas IS the control surface,
// the way the EQ's curve is. There is no cell row left at all.
//
//   • A TAP, ABOVE THE AXIS → sideways = TIME (the tap you're holding follows your cursor, so
//                         grabbing the 3rd echo and pulling right sets time to a third of where
//                         you drop it; SYNC snaps it to the note grid). Up/down = FEEDBACK, on a
//                         MONOTONIC fader — bottom of the swing 0%, top 100% — solved so THAT tap
//                         lands at that height (fb = amp^(1/n)), which is why a far tap gives fine
//                         control of the tail.
//   • A TAP, BELOW THE AXIS → the same tap's OTHER CHANNEL. The up/down mirror has always been the
//                         stereo axis (it's why ping-pong alternates across it), so the bar below
//                         the line is the RIGHT channel — and WIDTH *is* an L/R time spread. Drag
//                         it sideways and you are literally pulling the right channel off the left
//                         in time. That's not a metaphor for width; it's what width does.
//   • THE ROOF          → DRIVE. Saturation is a ceiling the signal runs into, so it's drawn as
//                         one: a line over the taps that you pull DOWN onto them. The tips that
//                         poke through go hot. At zero it rests exactly on a full-scale tap —
//                         nothing clips — and every pixel you pull it down is another echo driven
//                         into the curve. There's a grip at the right edge, but the whole line is
//                         live wherever a tap isn't.
//   • THE ENVELOPE'S HEAD → DUCK. The scoop the sidechain digs out of the front of the tail was
//                         ALREADY drawn here; it just wasn't grabbable. Pull the head of the decay
//                         curve down and the echoes duck harder under the dry. ★ This one is a
//                         RELATIVE drag, and the reason is the rule below.
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
//                         nothing to grab: it IS that line.
//
// ★★ THE RULE THAT DECIDES ABSOLUTE vs RELATIVE, and it decides every gesture here:
// A HANDLE MAY ONLY BE DRAGGED ABSOLUTELY IF ITS POSITION ACTUALLY STANDS FOR THE VALUE.
//   · a tap's height IS fb^n           → absolute (grab it by the tip and nothing moves)
//   · the shear IS the width           → absolute
//   · the roof's height IS the drive   → absolute
//   · the FIRST tap is pinned at unity by the topology (fb⁰ = 1 whatever fb is), so its height
//     stands for NOTHING                → relative, or clicking the fattest bar on screen would
//                                         slam feedback to the rail
//   · the envelope's height is fb AND duck together — it stands for neither alone → relative
//
// ★ AND ONE READOUT, ON TOP, ALWAYS. The numbers used to be scattered by whatever drew them: the
// cuts labelled themselves at the ribbon's edges, TIME·FB sat bottom-left, the wobble printed
// itself top-right but only while hovered. They MOVED depending on what you touched, which is the
// one thing a readout must never do. Now: one strip across the top. What the delay IS on the left,
// what you're TOUCHING in the middle, its tone on the right.
//
// Right-click resets whatever is under the cursor — a gesture you can't undo isn't a control, it's
// a trap.

type CharId = "width" | "drive" | "duck";

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
  drive: number; // analog saturation (0..1) — the roof
  duck: number; // sidechain ducking (0..1) — the envelope's head
  width: number; // stereo L/R time spread (0..1) — the shear
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
  // faster. That is the chop.
  onTime: (seconds: number) => number; // → the seconds it LOCKED to (snapped to the note grid)
  onFeedback: (v: number) => number;
  onFilters: (hp: number, lp: number) => [number, number];
  onMod: (depth: number, rate: number) => [number, number]; // the wobble — one gesture, two axes
  onChar: (id: CharId, v: number) => number; // width (the shear) · drive (the roof) · duck (the head)
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
const READOUT_H = 13; // the one readout strip, across the top
const GRIP_PX = 10; // how close counts as "on" a filter edge
const TAP_GRIP = 16; // ...and on a tap. Wider: the taps are a 3px bar and sit ~150px apart, so
// there's nothing to hit by accident, and a stingy grip just makes the surface feel dead.
const SHEAR_MAX = 26; // the R channel's biggest shear, in px — capped again by the tap spacing, or
// a wide delay would fling the right channel on top of the NEXT echo and the row would read as mush.
const DUCK_BEATS = 2; // how far into the tail the duck's scoop reaches — and so how far it's grabbable
const CEIL_GRIP = 7; // vertical reach of the roof line
const CEIL_TAB = 26; // ...and the width of its always-wins grip, at the right edge
const HOT = "#ffb066"; // what a tap looks like once it's poking through the roof
const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);

// log-frequency ↔ x, 20 Hz‥20 kHz across the width
const fToX = (f: number, w: number) => (Math.log(clamp(f, 20, 20000) / 20) / Math.log(1000)) * w;
const xToF = (x: number, w: number) => 20 * Math.exp((clamp(x, 0, w) / w) * Math.log(1000));

// THE ROOF. At drive 0 it rests exactly on the tip of a full-scale tap — nothing is driven. At
// drive 1 it has come down to 28% of the swing, and everything above that is in the curve.
const CEIL_LO = 0.72; // how far down the roof travels, as a fraction of maxBar
const ceilOf = (drive: number, midY: number, maxBar: number) => midY - maxBar * (1 - CEIL_LO * clamp01(drive));
const driveOf = (y: number, midY: number, maxBar: number) => clamp01((1 - (midY - y) / Math.max(1, maxBar)) / CEIL_LO);

type Grab =
  | { kind: "tap"; n: number; lower: boolean; ghostX: number; startY: number; startFb: number }
  | { kind: "hp" }
  | { kind: "lp" }
  | { kind: "band"; lastX: number }
  | { kind: "lfo"; startX: number; startRate: number }
  | { kind: "drive" }
  | { kind: "duck"; startY: number; startDuck: number };

export function DelayViz({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod, onChar }: DelayVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab | null>(null);
  const hover = useRef<string>(""); // which handle the cursor is over → cursor shape + highlight + readout
  const kickRef = useRef<() => void>(() => {}); // request one repaint (the loop idles when nothing moves)

  // The draw loop reads props through a ref so the pointer handlers (attached once) and the
  // renderer always agree on the same values.
  const p = useRef({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod, onChar });
  p.current = { time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod, onChar };

  // Geometry, shared by the renderer and the hit-tests — one source of truth, or the thing you
  // grab won't be the thing you see. Top to bottom: the READOUT strip, the tone RIBBON, then the
  // timeline, which now runs all the way to the floor (the character rail is gone — its three
  // params became gestures on the echoes themselves).
  const geom = (h: number, w = 999) => {
    const narrow = w < NARROW_PX;
    // The ribbon needs to be a THUMB target on a phone, not a hairline — it costs a little of the
    // timeline's height, which the timeline can spare.
    const ribbonH = narrow ? Math.max(26, Math.round(h * 0.22)) : Math.max(20, Math.round(h * 0.2));
    const ribY = READOUT_H;
    const top = ribY + ribbonH + 3;
    const botY = h - 2;
    const midY = top + (botY - top) / 2;
    return { ribbonH, ribY, top, botY, midY, maxBar: Math.max(6, (botY - top) * 0.42) };
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
  // ★ AND IT'S NARROWER ON A NARROW DECK. On a phone this canvas is ~172px, and at 1/8 in a
  // two-bar window the taps land ~11px apart — which forces the grip down to ~5px (it can never
  // exceed half the gap, or you grab the wrong echo). A 5px target is not a thumb target: the
  // whole instrument was unusable on touch. The answer isn't a bigger grip, it's FEWER TAPS ON
  // SCREEN — one bar instead of two doubles every gap, and doubles every grip with it.
  const windowOf = (beat: number, w: number) => {
    const bars = w < NARROW_PX ? 4 : 8; // beats of timeline
    return beat > 0 ? beat * bars : MAX_TIME * (w < NARROW_PX ? 0.6 : 1.2);
  };
  // The shear, in pixels, at width = 1 — capped by the gap to the next echo so a wide delay can
  // never throw the right channel across its neighbour.
  const shearOf = (t: number, windowSec: number, w: number) => Math.min(SHEAR_MAX, Math.max(6, (t / windowSec) * w * 0.34));

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

    // ★ THE WOBBLE'S PHASE IS INTEGRATED, NOT COMPUTED FROM THE CLOCK.
    //
    // It used to be phase = 2π·rate·elapsed, with `elapsed` measured from the canvas's mount. That
    // is a correct phase only while the rate never moves — the moment you drag the RATE, the phase
    // TELEPORTS: at 30 s in, nudging 1 Hz → 1.1 Hz jumps it by 2π·0.1·30 ≈ three whole cycles. A
    // sideways drag changes the rate on every pointermove, so the wave shimmered under your hand,
    // and because the taps are shifted by that same LFO value, the whole tap row jittered with it.
    // The fix is the one physics always gives you: a phase is the INTEGRAL of frequency. Accumulate
    // it — φ += 2π·rate·dt — and it stays continuous no matter what the rate does.
    let phase = 0;
    let lastNow = 0;

    // The decay envelope, as a continuous function of x — the curve the taps' tips ride, and the
    // thing the DUCK gesture grabs. Shared by the renderer and the hit-test, or you'd be pulling on
    // a curve that isn't the one you can see.
    const envAt = (sec: number, s: typeof p.current, beat: number) => {
      const t = Math.max(0.001, s.time);
      const tau = (beat > 0 ? beat : 0.5) * 0.5;
      const decay = s.frozen ? 1 : Math.pow(clamp(s.feedback, 0, 0.999), Math.max(0, sec / t - 1));
      return decay * (1 - clamp01(s.duck) * Math.exp(-sec / tau));
    };

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
      const { ribbonH, ribY, top, botY, midY, maxBar } = geom(h, w);
      const tlH = botY - top; // the timeline's height — the wave scales to THIS, not to the canvas
      // dt is CLAMPED: the loop idles whenever the wobble is still and nothing is being dragged, so
      // the first frame after a long idle would otherwise integrate minutes of phase in one step.
      const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
      lastNow = now;
      phase = (phase + 2 * Math.PI * s.modRate * dt) % (2 * Math.PI);
      const accent = s.accent;
      const held = g ? (g.kind === "tap" ? (g.lower ? "width" : "tap") : g.kind) : "";
      const hot = held || hover.current.replace(/^tap\d+$/, "tap").replace(/^lower\d+$/, "width");

      // === THE FILTER RIBBON — the echoes' tone window, and a control. Edges are grips; the body
      // sweeps the band. It sits UNDER the readout strip, so everything it draws is offset. ===
      ctx.save();
      ctx.translate(0, ribY);
      const lo = fToX(s.hp, w);
      const hi = fToX(s.lp, w);
      const rH = ribbonH - 4;
      const bandHot = hot === "band";
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, 0, w, rH);

      // A SPECTRUM RULER — decade ticks only, NO text. The strip is ~20px tall and the band's Hz
      // now live in the readout, so captions here would just be a second place numbers can hide.
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
        const on = hot === id;
        const gx = round(x);
        ctx.fillStyle = accent;
        ctx.globalAlpha = on ? 1 : 0.85;
        ctx.fillRect(gx - 1, 0, 3, rH);
        ctx.globalAlpha = on ? 0.9 : 0.55;
        ctx.fillStyle = "#000";
        for (let k = -1; k <= 1; k++) ctx.fillRect(gx, rH / 2 + k * 3, 1, 1);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      // beat grid + centre line (in the timeline only)
      if (beat > 0) {
        ctx.lineWidth = 1;
        for (let sec = beat, k = 1; sec < windowSec; sec += beat, k++) {
          ctx.strokeStyle = k % 4 === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
          const x = Math.round(xOf(sec)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, botY);
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
      // dragging sideways STRETCHES it — right is slower, left is faster.
      const modN = clamp01(s.modDepth / MOD_MAX);
      const lfoNow = modN * Math.sin(-phase);
      const lfoHot = hot === "lfo";
      if (modN > 0.001 && s.modRate > 0) {
        const lfoAmp = modN * tlH * LFO_AMP_FRAC;
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

      // === THE TAPS ===
      const wet = 0.35 + 0.65 * clamp01(s.mix);
      const modShift = lfoNow * 8;
      const shear = clamp01(s.width) * shearOf(t, windowSec, w);
      const ceilY = ceilOf(s.drive, midY, maxBar);
      const floorY = 2 * midY - ceilY; // the roof's mirror — the taps run both ways
      const barW = 3;
      const heldTap = g && g.kind === "tap" ? g.n : -1;
      // A tap, drawn from the axis outward — and CUT at the roof: the part that pokes through is
      // the part being driven into the curve, so it's drawn hot. The bar keeps its true height (the
      // drive doesn't lower the echo, it saturates it) — the roof is a threshold, not a limiter.
      const tap = (x: number, amp: number, side: "up" | "down", alpha: number, lit: boolean) => {
        const bh = Math.max(1, maxBar * amp);
        const bw = lit ? barW + 2 : barW;
        const bx = round(x - bw / 2);
        const y0 = side === "up" ? round(midY - bh) : round(midY);
        const y1 = side === "up" ? round(midY) : round(midY + bh);
        const cut = side === "up" ? ceilY : floorY;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = lit ? "#fff" : accent;
        if (side === "up") ctx.fillRect(bx, Math.max(y0, cut), bw, Math.max(0, y1 - Math.max(y0, cut)));
        else ctx.fillRect(bx, y0, bw, Math.max(0, Math.min(y1, cut) - y0));
        // …and the driven part, above the roof
        if (s.drive > 0.001) {
          ctx.fillStyle = HOT;
          if (side === "up" && y0 < cut) ctx.fillRect(bx, y0, bw, cut - y0);
          if (side === "down" && y1 > cut) ctx.fillRect(bx, cut, bw, y1 - cut);
        }
        ctx.globalAlpha = 1;
      };

      // the dry hit at t=0 — the source, not an echo. Never grabbable.
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(1, round(midY - maxBar), barW, round(maxBar * 2));
      ctx.globalAlpha = 1;

      // THE MAGNET, shown only while you're dragging a tap's TIME. TIME snaps to note divisions, so
      // the tap jumps from one to the next — and an unexplained jump reads as jitter. Draw the
      // targets and the same jump reads as magnetism, which is what it is.
      if (g && g.kind === "tap" && !g.lower && beat > 0 && s.snapBeats?.length) {
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

      // === THE DECAY ENVELOPE — and the DUCK's handle. Without the curve the tail is a row of
      // ever-shorter bars fading to nothing, so "grab the tail" means aiming at a 2px stub. With it,
      // the SCOOP the sidechain digs out of the head is a shape you can see — and therefore one you
      // can pull. The head is drawn fat and live; the rest of the curve is just a guide.
      const duckX = xOf(Math.min(windowSec, (beat > 0 ? beat : 0.5) * DUCK_BEATS));
      const duckHot = hot === "duck";
      if (!s.frozen) {
        for (const head of [true, false]) {
          ctx.beginPath();
          let moved = false;
          for (let x = 0; x <= w; x += 2) {
            if (head !== (x <= duckX)) continue;
            const y = midY - maxBar * envAt((x / w) * windowSec, s, beat);
            moved ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            moved = true;
          }
          ctx.strokeStyle = head && duckHot ? "#fff" : accent;
          ctx.globalAlpha = head ? (duckHot ? 0.95 : 0.5) : 0.28;
          ctx.lineWidth = head ? (duckHot ? 2.5 : 1.5) : 1;
          ctx.setLineDash(head ? [] : [3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }

      ctx.shadowColor = "rgba(255,170,90,0.9)";
      ctx.shadowBlur = clamp01(s.drive) * 8;
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        const base = s.frozen ? 1 : Math.pow(clamp(s.feedback, 0, 0.999), n);
        if (!s.frozen && base < 0.02) break;
        const amp = envAt(ts, s, beat); // = fb^n × the duck gain — the very curve the envelope draws
        const where = s.pingpong ? (n % 2 === 0 ? "up" : "down") : "both";
        const x = xOf(ts) + modShift;
        const a = 0.55 + 0.45 * amp * wet;
        const lit = n === heldTap || hover.current === `tap${n}` || hover.current === `lower${n}`;
        // ★ THE SHEAR IS THE WIDTH. The up/down mirror has always been the stereo axis — it's why
        // ping-pong alternates across it — so the left channel leads and the right channel lags by
        // the spread. In ping-pong each echo is only ONE channel, so it still shears, just alone.
        if (where === "up" || where === "both") tap(x - shear, amp, "up", a, lit);
        if (where === "down" || where === "both") tap(x + shear, amp, "down", a, lit);
      }
      ctx.shadowBlur = 0;

      // === THE ROOF — DRIVE. A line you pull down onto the echoes; what pokes through goes hot.
      // Live along its whole length (wherever a tap isn't), with a grip at the right edge that
      // always wins, so there is never a drive setting you can't reach.
      const driveHot = hot === "drive";
      ctx.strokeStyle = s.drive > 0.001 ? HOT : accent;
      ctx.globalAlpha = driveHot ? 0.95 : s.drive > 0.001 ? 0.55 : 0.3;
      ctx.lineWidth = driveHot ? 2 : 1;
      ctx.setLineDash([5, 4]);
      for (const y of [ceilY, floorY]) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w - CEIL_TAB, Math.round(y) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // the grip — a solid tab, the one part of the roof that can never be stolen by a tap
      ctx.fillStyle = s.drive > 0.001 ? HOT : accent;
      ctx.globalAlpha = driveHot ? 1 : 0.7;
      ctx.fillRect(w - CEIL_TAB + 2, Math.round(ceilY) - 1, CEIL_TAB - 2, 3);
      ctx.globalAlpha = 1;

      // === THE ONE READOUT — topmost, three fixed zones, always in the same place.
      // LEFT: what the delay IS. MIDDLE: what you're TOUCHING (blank when you aren't). RIGHT: its
      // tone. Nearest-rung naming is done from the value we just PAINTED, never from a prop that
      // arrives a render late (mid-drag, that lags a whole division behind the tap under your hand).
      const nameOf = (v: number, rungs?: number[], names?: string[]) => {
        if (!rungs?.length || !names?.length) return null;
        let bi = 0;
        let bd = Infinity;
        rungs.forEach((r, i) => {
          const d = Math.abs(Math.log(r / Math.max(1e-4, v)));
          if (d < bd) {
            bd = d;
            bi = i;
          }
        });
        return names[bi] ?? null;
      };
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, w, READOUT_H - 1);
      const ry = (READOUT_H - 1) / 2;
      ctx.font = "800 9px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = accent;
      ctx.textAlign = "left";
      ctx.globalAlpha = 0.9;
      const timeLabel = (beat > 0 && nameOf(t / beat, s.snapBeats, s.snapLabels)) || `${Math.round(t * 1000)}ms`;
      ctx.fillText(`${timeLabel}  ·  ${Math.round(clamp01(s.feedback) * 100)}%`, 5, ry);
      ctx.textAlign = "right";
      ctx.globalAlpha = 0.55;
      ctx.fillText(`${fmtF(s.hp)} – ${fmtF(s.lp)}`, w - 5, ry);
      // the middle — the contextual "this is the thing in my hand"
      const pct = (v: number) => `${Math.round(clamp01(v) * 100)}%`;
      const ctxLabel =
        hot === "width" ? `WIDTH ${pct(s.width)}`
        : hot === "drive" ? `DRIVE ${pct(s.drive)}`
        : hot === "duck" ? `DUCK ${pct(s.duck)}`
        : hot === "lfo" ? `WOBBLE ${pct(modN)} · ${(beat > 0 && nameOf(1 / Math.max(1e-4, s.modRate) / beat, s.modSnapBeats, s.modSnapLabels)) || `${s.modRate.toFixed(2)} Hz`}`
        : hot === "hp" || hot === "lp" || hot === "band" ? `${fmtF(s.hp)} Hz – ${fmtF(s.lp)} Hz`
        : hot === "tap" ? `ECHO ${(heldTap >= 0 ? heldTap : Number(hover.current.slice(3))) + 1}`
        : "";
      if (ctxLabel) {
        ctx.textAlign = "center";
        ctx.globalAlpha = 1;
        ctx.fillStyle = held ? "#fff" : accent;
        ctx.fillText(ctxLabel, w / 2, ry);
      }
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
    // PRIORITY, and every clash in it is deliberate:
    //   the roof's GRIP  — a tab at the right edge that nothing may steal, so drive is always reachable
    //   a TAP            — the primary gesture; it owns its ±grip of x, at any height
    //   the DUCK head    — the fat part of the envelope, over the first couple of beats
    //   the ROOF line    — everywhere else along it
    //   the WOBBLE       — the centre band
    const hitAt = (px: number, py: number): { kind: string; n?: number; lower?: boolean } | null => {
      const w = lastW;
      const h = lastH;
      const s = p.current;
      const { ribbonH, ribY, top, botY, midY, maxBar } = geom(h, w);
      if (py < ribY) return null; // the readout strip is a label, not a control
      if (py <= ribY + ribbonH) {
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
      if (py < top || py > botY) return null;

      const t = Math.max(0.001, s.time);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const windowSec = windowOf(beat, w);
      const ceilY = ceilOf(s.drive, midY, maxBar);
      const floorY = 2 * midY - ceilY;
      // the roof's grip — highest priority, and the reason the rest of the line may fight with taps
      if (px >= w - CEIL_TAB && (Math.abs(py - ceilY) <= CEIL_GRIP + 3 || Math.abs(py - floorY) <= CEIL_GRIP + 3)) return { kind: "drive" };

      let best = -1;
      // The grip can never be wider than half the gap to the next tap, or neighbouring grips
      // overlap and you grab the wrong echo. At 1/16 in a two-bar window the taps are ~24px apart.
      let bestD = Math.min(TAP_GRIP, Math.max(4, ((t / windowSec) * w) / 2));
      const shear = clamp01(s.width) * shearOf(t, windowSec, w);
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        // Only grab a tap you can SEE. An invisible one (decayed past the draw threshold) offered
        // absurd leverage — fb = amp^(1/n) with a big n turns a 2px nudge into a jump to 95%.
        const base = s.frozen ? 1 : Math.pow(clamp(s.feedback, 0, 0.999), n);
        if (!s.frozen && base < 0.02) break;
        // measure to the HALF you're actually over — the two channels are sheared apart
        const cx = (ts / windowSec) * w + (py > midY ? shear : -shear);
        const d = Math.abs(px - cx);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best >= 0) {
        // ★ BELOW THE AXIS IS THE RIGHT CHANNEL, and dragging it in time IS the width. Except in
        // ping-pong, where an even echo has no lower half at all — there's no right channel there
        // to pull, so it stays a plain TIME grab.
        const lower = py > midY && (!s.pingpong || best % 2 === 1);
        return { kind: "tap", n: best, lower };
      }

      // the DUCK head — the fat part of the envelope, where the scoop actually lives
      const duckX = ((beat > 0 ? beat : 0.5) * DUCK_BEATS * w) / windowSec;
      if (px <= duckX && py < midY) {
        const envY = midY - maxBar * envAt((px / lastW) * windowSec, s, beat);
        if (Math.abs(py - envY) <= 14) return { kind: "duck" };
      }
      // the ROOF, along the rest of its length
      if (Math.abs(py - ceilY) <= CEIL_GRIP || Math.abs(py - floorY) <= CEIL_GRIP) return { kind: "drive" };

      // THE WOBBLE: anywhere on the wave, between the taps. At depth 0 the wave IS the centre line,
      // so there's always something to grab — the resting wobble is never a ghost. Hit-test the BAND
      // the wave sweeps, not one frozen phase of it: the wave is scrolling, so testing the
      // instantaneous curve would move the target out from under a stationary cursor 60×/second.
      const modN = clamp01(s.modDepth / MOD_MAX);
      const lfoAmp = modN * (botY - top) * LFO_AMP_FRAC;
      const reach = Math.max(GRIP_PX, lfoAmp + GRIP_PX);
      return Math.abs(py - midY) <= reach ? { kind: "lfo" } : null;
    };

    // ★ Paint from what we just computed — never wait for a React round-trip. The handlers push the
    // new value into the device AND into `p.current`, so the very next frame draws the gesture that
    // produced it. (The next real render overwrites the mirror with the device's own values, which
    // agree — so this is a lead, not a lie.)
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
    const setChar = (id: CharId, v: number) => {
      const c = p.current.onChar(id, clamp01(v));
      if (id === "width") p.current.width = c;
      else if (id === "drive") p.current.drive = c;
      else p.current.duck = c;
    };

    const apply = (px: number, py: number) => {
      const g = grab.current;
      if (!g) return;
      const w = lastW;
      const h = lastH;
      const s = p.current;
      const { top, botY, midY, maxBar } = geom(h, w);
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
      if (g.kind === "drive") {
        // ABSOLUTE — the roof's height IS the drive. Grab either the roof or its mirror; both come
        // down together, because the taps run both ways and there is only one ceiling.
        setChar("drive", driveOf(py > midY ? 2 * midY - py : py, midY, maxBar));
        return;
      }
      if (g.kind === "duck") {
        // RELATIVE — and this is the rule doing real work. The envelope's height is fb AND duck
        // TOGETHER; it stands for neither one alone, so an absolute law here would have the head
        // jump the moment you touched it. Pull DOWN to duck harder.
        setChar("duck", g.startDuck + (py - g.startY) / Math.max(1, maxBar * 1.5));
        return;
      }
      if (g.kind === "lfo") {
        // DEPTH is absolute: the wave's height follows your finger off the centre line.
        const full = Math.max(1, (botY - top) * LFO_AMP_FRAC);
        const depth = clamp01(Math.abs(py - midY) / full) * MOD_MAX;
        // RATE is a STRETCH, and stretches are relative: drag right and the wave lengthens under
        // your hand (slower), left and it compresses (faster). Log-scaled, so one full-width drag
        // spans the whole 0.02‥8 Hz range and every octave of it feels the same width.
        const span = Math.log(RATE_MAX / RATE_MIN);
        const rate = clamp(g.startRate * Math.exp((-(px - g.startX) / w) * span), RATE_MIN, RATE_MAX);
        setMod(depth, rate);
        return;
      }
      // A TAP. Y is FEEDBACK either way. X is TIME above the axis, and WIDTH below it.
      g.ghostX = px;
      const beat = s.bpm ? 60 / s.bpm : 0;
      const windowSec = windowOf(beat, w);
      const swing = Math.max(1, 2 * maxBar); // the full drawn height of a tap, bottom tip to top tip

      if (g.lower) {
        // ★ WIDTH — absolute, because the shear IS the width: the bar under your finger is the right
        // channel, and its distance from the echo's true time is the spread. So the bar follows the
        // cursor exactly, and letting go leaves it where you left it.
        const trueX = ((g.n + 1) * Math.max(0.001, s.time) * w) / windowSec;
        setChar("width", (px - trueX) / shearOf(Math.max(0.001, s.time), windowSec, w));
      } else {
        const secAt = (clamp(px, 1, w) / w) * windowSec;
        setTime(clamp(secAt / (g.n + 1), 0.02, MAX_TIME));
      }

      // ★ THE VERTICAL LAW IS MONOTONIC — the bottom of a tap's swing is 0%, the top is 100%.
      // It used to be |py − midY| / maxBar: the DISTANCE from the centre line. That made the CENTRE
      // 0% and BOTH the top and the bottom 100% — a bipolar law on a control with no negative half.
      if (g.n >= 1) {
        // amp = fb^n  ⇒  fb = amp^(1/n): solve for the tap you're actually HOLDING, so it lands
        // under your finger. Jump-free by construction — a tap's tip already sits at its own value.
        const amp = clamp01((midY + maxBar - py) / swing);
        setFeedback(clamp(Math.pow(Math.max(amp, 1e-4), 1 / g.n), 0, FB_MAX));
        return;
      }
      // ★ THE FIRST ECHO IS PINNED AT UNITY by the topology — out = x(t−T) + fb·out(t−T) — so fb⁰=1
      // whatever fb is, and its HEIGHT cannot encode the tail. It can't be absolute: a full-height
      // bar that doesn't stand for its value would slam feedback to the rail the moment you grabbed
      // the fattest thing on screen. So this one drag is RELATIVE — same sensitivity as its
      // neighbours, anchored where the tail already is.
      setFeedback(clamp(g.startFb + (g.startY - py) / swing, 0, FB_MAX));
    };

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    const idOf = (hit: { kind: string; n?: number; lower?: boolean }) => (hit.kind === "tap" ? (hit.lower ? `lower${hit.n}` : `tap${hit.n}`) : hit.kind);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { px, py } = local(e);
      const hit = hitAt(px, py);
      if (!hit) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (hit.kind === "tap") grab.current = { kind: "tap", n: hit.n!, lower: !!hit.lower, ghostX: px, startY: py, startFb: p.current.feedback };
      else if (hit.kind === "drive") grab.current = { kind: "drive" };
      else if (hit.kind === "duck") grab.current = { kind: "duck", startY: py, startDuck: p.current.duck };
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
      const id = hit ? idOf(hit) : "";
      if (id !== hover.current) {
        hover.current = id;
        canvas.style.cursor = !hit
          ? "default"
          : hit.kind === "band"
            ? "grab"
            : hit.kind === "tap"
              ? hit.lower
                ? "ew-resize"
                : "move"
              : hit.kind === "lfo"
                ? "crosshair"
                : hit.kind === "drive" || hit.kind === "duck"
                  ? "ns-resize"
                  : "ew-resize";
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
      else if (hit.kind === "drive") setChar("drive", 0);
      else if (hit.kind === "duck") setChar("duck", 0);
      else if (hit.kind === "tap") hit.lower ? setChar("width", 0) : setFeedback(0.38);
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

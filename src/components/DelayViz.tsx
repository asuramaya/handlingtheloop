import { useEffect, useRef } from "react";
import type { Deck, DelayFx } from "@htl/audio";
import { dragBand, dragHp, dragLp, drawFreqRibbon, fmtHz, hitFreqRibbon, type RibbonHot, type RibbonRange } from "./FreqRibbon";

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
//   • THE TWO GUTTERS  → DUCK (left) and DRIVE (right): a full-height LANE at each end of the
//                         timeline, reserved in the timeline's own coordinate space (secToX), not
//                         just in hit-test priority — an echo cannot land here any more. A thin
//                         rail + a puck riding it, the same shrink-what-you-look-at split the taps
//                         use: the full lane stays the touch target, only the paint got smaller.
//                         Bottom 0 → top 100, absolute; the puck's level IS the value.
//                         ★ THE LAW CHOSE THE HANDLE, not the other way round. Once every vertical
//                         magnitude here runs bottom-to-top over the full height, a handle has to
//                         span that height too — grab the FIRE, which lives at the top edge, and a
//                         bottom-to-top law slams it to 100% the instant you touch it. The handle
//                         and the law must agree, or the control lies on touch-down. So the fire and
//                         the shadow stay — as what these two DO, not as what you grab.
//                         SHOW THE EFFECT; HAND ME THE HANDLE.
//   • THE FIRE          → what DRIVE does. Not a line: a line gets read as a LEVEL, and every level
//                         on this surface grows outward from the axis, while a saturation threshold
//                         must come DOWN to bite — so as a line it said "less" while meaning "more".
//                         As fire it says exactly what it means: pull the drive up and more of the
//                         canvas burns, and the echoes standing in it are the ones being driven into
//                         the curve. ★ AND IT BURNS IN THE DECK'S OWN COLOUR. It was orange, a hue I
//                         invented, which made it read as a foreign object rather than as THIS
//                         effect getting hotter. The heat is the accent, composited additively so it
//                         accumulates the way light does, and the driven length of each tap burns
//                         toward white. INTENSITY carries the magnitude; the hue never leaves the
//                         theme. Nothing here should introduce a colour the deck didn't already own.
//   • THE SHADOW        → what DUCK does. The dry hit is the SIDECHAIN SOURCE — it is literally what
//                         does the ducking — so the shadow it throws across the head of the tail is
//                         the duck, made visible: the wedge between where the echoes would be and
//                         where the duck puts them. It lives in the left gutter for that reason.
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
// ★★ TWO GRAMMARS, and they are not the same one — which is the thing that took three tries to see.
//
// WHAT YOU SEE: every magnitude is drawn as a DISTANCE FROM THE CENTRE LINE. A tap grows outward
// with feedback, the wobble swells outward with depth, the shear pushes outward with width. The eye
// learns that in the first second and reads everything else through it — which is why drive-as-a-
// descending-line felt inverted even though the physics was right. A control can be correct and
// still be unreadable, and the grammar wins, because the grammar is what you actually read.
//
// WHAT YOU DO: every vertical magnitude is dragged BOTTOM 0 → TOP 100. Monotonic, one direction,
// no exceptions. The drawing may be symmetric about the axis — a wave really is, a tap really is —
// but a symmetric PICTURE does not license a bipolar LAW. Depth, drive, duck and feedback have no
// negative half, and a control with no negative half must never have a centre that means zero. That
// bug has now been killed three times on this one canvas (the taps, then the wobble, then drive),
// because each time it hid inside something that was legitimately mirrored on screen.
//
// ★★ THE RULE THAT DECIDES ABSOLUTE vs RELATIVE, and it decides every gesture here:
// A HANDLE MAY ONLY BE DRAGGED ABSOLUTELY IF ITS POSITION ACTUALLY STANDS FOR THE VALUE.
//   · a tap's height IS fb^n           → absolute (grab it by the tip and nothing moves)
//   · the shear IS the width           → absolute
//   · a gutter's fill level IS its value → absolute (drive and duck both)
//   · ★ and note what a gutter bought: on the envelope, duck's height was feedback and duck TOGETHER
//     — it stood for neither alone, so the law had to be RELATIVE. Give a control pixels of its own
//     and the position starts standing for the value, which hands you the absolute law for free.
//     THE RIGHT HOME AND THE RIGHT LAW ARRIVE TOGETHER. If a re-sited control still needs a relative
//     law, the home is still wrong — that is a test, and it is cheap to run.
//   · the FIRST tap is pinned at unity by the topology (fb⁰ = 1 whatever fb is), so its height
//     stands for NOTHING                → relative, or clicking the fattest bar on screen would
//                                         slam feedback to the rail
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
  deck: Deck; // ★ for duckGain ONLY — the live sidechain readback has no JS-side commanded value,
  // so it can't travel through the same prop channel as everything else here; it's read straight
  // off the device each frame, the one place on this canvas that's audio-reactive, not state-driven.
  slot: number;
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
  // RPT/DIG/FADE — what a TIME change does to a ringing tail (see DelayFx.TimeMode). It has no
  // magnitude, so it can't grow a fire or throw a shadow — instead it's a CAP on every tap: the
  // shape of the tip is what that tap's transition would look like, always visible, not just
  // during a drag. See the `tap()` draw fn for the three shapes.
  timeMode: number;
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
const TAP_GRIP = 16; // ...and on a tap. Wider: the taps are a thin bar and sit ~150px apart, so
// there's nothing to hit by accident, and a stingy grip just makes the surface feel dead.
const SHEAR_MAX = 26; // the R channel's biggest shear, in px — capped again by the tap spacing, or
// a wide delay would fling the right channel on top of the NEXT echo and the row would read as mush.
// ★ THE TWO GUTTERS — a full-height column at each END of the timeline. DUCK on the left (the dry
// hit already WAS such a column: t=0, full height, and the literal sidechain source), DRIVE on the
// right. Nothing else can reach these pixels, which is the whole point: a control whose law spans
// the full height needs a handle that spans the full height, or grabbing it anywhere lands you
// somewhere you didn't ask for. The fire and the shadow are what these two DO — they are not what
// you grab. Show the effect; hand me the handle.
const GUTTER = 15;
const GUTTER_WIDE = 22; // a thumb is not a mouse — this is now purely a HIT-ZONE + timeline-
// exclusion width; the PAINT is much thinner (below), same split the taps already use.
const GUTTER_MARGIN = 2; // the rail's distance from the true canvas edge
const RAIL_W = 3; // the always-visible track
const PUCK_W = 11; // the level indicator riding the rail
// The band's own bounds — shared with FreqRibbon's drag math, not baked into it, since the
// reverb's tail window has different real bounds and shouldn't silently inherit the delay's.
const RIBBON_RANGE: RibbonRange = { min: HP_MIN, max: LP_MAX, minRatio: BAND_MIN_RATIO };

// THE FIRE'S INNER EDGE. At drive 0 it rests exactly on the tip of a full-scale tap — nothing is
// driven, and there is no fire. At drive 1 it has come all the way in to the axis — a full-scale
// tap is entirely in the curve. It is never DRAWN as a line (see the header); only its tab is.
const CEIL_LO = 1; // how far down the roof travels, as a fraction of maxBar — 1 means full drive
// can reach the axis. It used to stop at 0.72, leaving a permanent unlit band near the axis no
// matter how hard drive was pushed — the roof has to be able to close the whole gap, or "more
// drive" stops meaning anything past that point.
const ceilOf = (drive: number, midY: number, maxBar: number) => midY - maxBar * (1 - CEIL_LO * clamp01(drive));

type Grab =
  | { kind: "tap"; n: number; lower: boolean; ghostX: number; startY: number; startFb: number }
  | { kind: "hp" }
  | { kind: "lp" }
  | { kind: "band"; lastX: number }
  | { kind: "lfo"; startX: number; startRate: number }
  | { kind: "drive" }
  | { kind: "duck" };

export function DelayViz({ deck, slot, time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, timeMode, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod, onChar }: DelayVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab | null>(null);
  const hover = useRef<string>(""); // which handle the cursor is over → cursor shape + highlight + readout
  const kickRef = useRef<() => void>(() => {}); // request one repaint (the loop idles when nothing moves)

  // The draw loop reads props through a ref so the pointer handlers (attached once) and the
  // renderer always agree on the same values.
  const p = useRef({ deck, slot, time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, timeMode, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod, onChar });
  p.current = { deck, slot, time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, timeMode, snapBeats, snapLabels, modSnapBeats, modSnapLabels, onTime, onFeedback, onFilters, onMod, onChar };

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
  // never throw the right channel across its neighbour. Scaled to the INNER span (w minus both
  // gutters) — the taps' own usable width, not the full canvas.
  const shearOf = (t: number, windowSec: number, w: number) => {
    const gw = w < NARROW_PX ? GUTTER_WIDE : GUTTER;
    const innerW = Math.max(1, w - 2 * gw);
    return Math.min(SHEAR_MAX, Math.max(6, (t / windowSec) * innerW * 0.34));
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

    // The envelope, split into its two factors.
    //   decayAt  — where the tail WOULD be: fb^n, and nothing else. Position-based; it's a
    //              property of the delay line, so it only depends on WHERE an echo sits.
    //   duckGain — ★ NOT position-based. It used to be — 1 − duck·e^(−t/τ), a fixed decay drawn
    //              once from t=0 — but that shape was FICTION: the real duck (DelayFx.duckGain) is
    //              a live sidechain, a 12Hz-smoothed envelope follower on the actual dry input,
    //              scaling the WHOLE merged wet signal together, uniformly, in real time — it
    //              doesn't care how far an echo is from the start, it cares whether something is
    //              hitting the input RIGHT NOW. So it's read once per frame (see draw()) and
    //              applied as a single scalar, not a function of `sec` — the picture now pumps
    //              with the actual audio instead of drawing a shape that was never really there.
    const decayAt = (sec: number, s: typeof p.current) => {
      const t = Math.max(0.001, s.time);
      return s.frozen ? 1 : Math.pow(clamp(s.feedback, 0, 0.999), Math.max(0, sec / t - 1));
    };
    const envAt = (sec: number, s: typeof p.current, duckGain: number) => decayAt(sec, s) * duckGain;

    // ★ THE TIMELINE'S OWN SPACE EXCLUDES THE GUTTERS — reserved geometrically, not refereed.
    //
    // It used to be that xOf mapped seconds across the FULL 0..w, and the gutters were painted
    // OVER whatever landed underneath — a hit-test priority check (`px <= gw` wins) kept a click
    // from reaching a tap in that zone, but the tap could still be DRAWN there, and at a
    // compressed enough window it could be the ONLY thing at that x — silently unreachable, not
    // merely crowded. secToX/xToSec make gw..w-gw the timeline's actual coordinate space, so an
    // echo can no longer land where duck/drive live, at any width. There's nothing left to
    // referee after the fact.
    const gutterOf = (w: number) => (w < NARROW_PX ? GUTTER_WIDE : GUTTER);
    const secToX = (sec: number, w: number, windowSec: number) => {
      const gw = gutterOf(w);
      return gw + (sec / windowSec) * Math.max(1, w - 2 * gw);
    };
    const xToSec = (x: number, w: number, windowSec: number) => {
      const gw = gutterOf(w);
      return ((x - gw) / Math.max(1, w - 2 * gw)) * windowSec;
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
      // The one audio-reactive read on this whole canvas — everything else here is state, this is
      // sound. Falls back to 1 (not ducking) if the device isn't resolved yet.
      const dev = s.deck.fxDeviceAt(s.slot) as DelayFx | undefined;
      const duckGain = dev ? clamp01(dev.duckGain) : 1;
      const duckPulse = clamp01(1 - duckGain); // 0 = quiet, rises toward duck's ceiling on a hit
      const xOf = (sec: number) => secToX(sec, w, windowSec);
      const xOfInv = (x: number) => xToSec(x, w, windowSec);
      const { ribbonH, ribY, top, botY, midY, maxBar } = geom(h, w);
      const tlH = botY - top; // the timeline's height — the wave scales to THIS, not to the canvas
      const gw = gutterOf(w); // the gutters' width — also the timeline's own left/right margin now
      // dt is CLAMPED: the loop idles whenever the wobble is still and nothing is being dragged, so
      // the first frame after a long idle would otherwise integrate minutes of phase in one step.
      const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
      lastNow = now;
      phase = (phase + 2 * Math.PI * s.modRate * dt) % (2 * Math.PI);
      const accent = s.accent;
      const held = g ? (g.kind === "tap" ? (g.lower ? "width" : "tap") : g.kind) : "";
      const hot = held || hover.current.replace(/^tap\d+$/, "tap").replace(/^lower\d+$/, "width");

      // === THE FILTER RIBBON — the echoes' tone window, and a control. Shared with the reverb's
      // dome (FreqRibbon.ts) — one control, not two hand-derived copies. ===
      const rH = ribbonH - 4;
      drawFreqRibbon(ctx, { x: 0, y: ribY, w, h: rH }, s.hp, s.lp, accent, (hot === "hp" || hot === "lp" || hot === "band" ? hot : null) as RibbonHot);

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
        // Same wave the taps ride (x = xOf(ts) + modShift) — drawn from each pixel's OWN time via
        // xOfInv, not a spatial-frequency approximation, so it can span the inset timeline (gw..
        // w-gw) without the gutters distorting its period.
        ctx.beginPath();
        for (let x = gw; x <= w - gw; x += 2) {
          const y = midY + lfoAmp * Math.sin(2 * Math.PI * s.modRate * xOfInv(x) - phase);
          x === gw ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
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
      const barW = 5;
      const tapW = 6; // the echo taps' own width — separate from barW (the dry hit, unaffected by
      // time-mode): a tip-sized cap read as noise on a 3px bar, so the WHOLE bar had to widen to
      // have room to actually change shape (see fillModeBar below).
      const SKEW = 3; // REPITCH's lean, in px
      const heldTap = g && g.kind === "tap" ? g.n : -1;
      // THE BAR'S OWN SHAPE — RPT/DIG/FADE has no magnitude, so it can't grow a fire or throw a
      // shadow the way drive/duck do. A tip-sized cap on an otherwise-plain rectangle read as noise
      // (verified: illegible at real scale even once the cap itself was enlarged) — the shape has
      // to be the WHOLE bar, or there's nothing to actually see at a glance. REPITCH leans into a
      // parallelogram (a glide has a slope) — the same lean the whole way up, tip to axis, not a
      // notch at one end. DIGITAL stays the plain rectangle it already was: exact, no slope, no
      // curve — the ABSENCE of a shape is itself the shape. FADE tapers to a point at the tip —
      // getting thinner is what a fade-out looks like.
      //
      // ★ THE PATH SPANS THE WHOLE BAR (tip to axis), NEVER JUST THE PART BELOW THE ROOF. It used
      // to be built only from the post-cut sub-region, with the driven (fire) segment stacked on
      // top as a separate plain ctx.fillRect — a leaning or tapered edge meeting a square one is a
      // visible kink, and at real scale it reads as a checkmark glued onto the tap, not one shape.
      // Building the path across the true full height and CLIPPING every fill to it means the fire
      // recolours the same silhouette instead of squaring off its own.
      const modeBarPath = (bx: number, y: number, bw: number, h: number, side: "up" | "down", mode: number): Path2D | null => {
        if (h <= 0) return null;
        const path = new Path2D();
        if (mode === 0) {
          const tipAtTop = side === "up";
          const topX = tipAtTop ? bx + SKEW : bx;
          const botX = tipAtTop ? bx : bx + SKEW;
          path.moveTo(botX, y + h);
          path.lineTo(botX + bw, y + h);
          path.lineTo(topX + bw, y);
          path.lineTo(topX, y);
          path.closePath();
        } else if (mode === 2) {
          const tipAtTop = side === "up";
          const tipX = bx + bw / 2;
          if (tipAtTop) {
            path.moveTo(bx, y + h);
            path.lineTo(bx + bw, y + h);
            path.lineTo(tipX, y);
          } else {
            path.moveTo(bx, y);
            path.lineTo(bx + bw, y);
            path.lineTo(tipX, y + h);
          }
          path.closePath();
        } else {
          path.rect(bx, y, bw, h);
        }
        return path;
      };
      // A tap, drawn from the axis outward — and CUT at the roof: the part that pokes through is
      // the part being driven into the curve, so it's drawn hot. The bar keeps its true height (the
      // drive doesn't lower the echo, it saturates it) — the roof is a threshold, not a limiter.
      const tap = (x: number, amp: number, side: "up" | "down", alpha: number, lit: boolean) => {
        const bh = Math.max(1, maxBar * amp);
        const bw = lit ? tapW + 2 : tapW;
        const bx = round(x - bw / 2);
        const y0 = side === "up" ? round(midY - bh) : round(midY);
        const y1 = side === "up" ? round(midY) : round(midY + bh);
        const cut = side === "up" ? ceilY : floorY;
        const path = modeBarPath(bx, y0, bw, y1 - y0, side, s.timeMode);
        if (!path) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = lit ? "#fff" : accent;
        ctx.fill(path);
        // …and the DRIVEN part — the length of it that stands inside the fire, CLIPPED to the same
        // path so its edge follows the tap's own shape (a lean, a taper) instead of squaring it off
        // with a straight rectangle. ★ It is not a new COLOUR, it is more of the SAME one. An
        // arbitrary orange says "a different thing is happening here"; what's actually happening is
        // the same echo, harder. So the driven length burns toward white along the deck's own
        // accent — INTENSITY carries the magnitude, and the hue never leaves the theme.
        const drivenTop = side === "up" ? y0 : cut;
        const drivenBot = side === "up" ? cut : y1;
        if (s.drive > 0.001 && drivenBot > drivenTop) {
          ctx.save();
          ctx.clip(path);
          ctx.fillStyle = accent;
          ctx.fillRect(bx, drivenTop, bw, drivenBot - drivenTop);
          ctx.globalCompositeOperation = "lighter";
          ctx.fillStyle = "#fff";
          ctx.globalAlpha = alpha * 0.75 * clamp01(s.drive);
          ctx.fillRect(bx, drivenTop, bw, drivenBot - drivenTop);
          ctx.globalCompositeOperation = "source-over";
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      };

      // === THE FIRE — DRIVE. Not a line (see the header), and no longer a HANDLE either: the fire
      // is what the drive DOES, and the gutter on the right is what you grab. A control whose law
      // runs the full height of the timeline needs a handle that runs the full height too — grab an
      // effect that lives at the top edge and a bottom-to-top law would slam it to 100% the moment
      // you touched it. Show the effect; hand me the handle.
      //
      // ★ AND IT BURNS IN THE DECK'S OWN COLOUR. It was orange, which was a hue I invented — it made
      // the fire read as a foreign object rather than as this effect getting hotter. The heat is the
      // accent, composited ADDITIVELY so it accumulates the way light does, and drive is carried by
      // INTENSITY alone.
      const heat = clamp01(s.drive);
      if (heat > 0.001) {
        // Washes the ECHOES' own span (gw..w-gw) now, not the full canvas — the gutters are a
        // separate lane with their own visual language (the rail below), not more fuel for the fire.
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.42 * heat;
        let grad = ctx.createLinearGradient(0, top, 0, Math.max(top + 1, ceilY));
        grad.addColorStop(0, accent);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.fillRect(gw, top, Math.max(0, w - 2 * gw), Math.max(0, ceilY - top));
        grad = ctx.createLinearGradient(0, Math.min(botY - 1, floorY), 0, botY);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(1, accent);
        ctx.fillStyle = grad;
        ctx.fillRect(gw, floorY, Math.max(0, w - 2 * gw), Math.max(0, botY - floorY));
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }

      // === THE DRY HIT'S SHADOW — THE CEILING, plus the LIVE line inside it.
      //
      // ★ ONE LIVE SCALAR ISN'T ENOUGH — a silent room can't owe you nothing just because nothing's
      // playing. duckGain sits at 1 whenever there's no signal (correctly — nothing IS ducking), so
      // a shadow drawn ONLY from the live value goes flat-out invisible the moment you drag the
      // gutter with no track running: the knob visibly moved, the picture didn't. That's a real
      // regression, not a live-feed purity win.
      //
      // So there are two curves now, and they answer two different questions:
      //   THE CEILING (filled band) — how far duck COULD reach, at the knob's CURRENT setting. Pure
      //   function of dv (the set amount): decayAt(sec)·(1−dv). Moves the instant you drag, with or
      //   without a signal — the feedback a silent room still owes you.
      //   THE LIVE LINE — where the pump actually IS, right now: decayAt(sec)·duckGain. Sits exactly
      //   ON the dry-reference ghost at rest (duckGain=1, nothing to show) and sweeps down toward the
      //   ceiling as something hits the input — the honest, audio-reactive half.
      const duckHot = hot === "duck";
      const dv = clamp01(s.duck);
      if (dv > 0.001) {
        const ceilGain = 1 - dv;
        for (const up of [true, false]) {
          const yOf = (v: number) => (up ? midY - maxBar * v : midY + maxBar * v);
          // the ceiling band — what the SETTING allows, independent of whether anything's playing.
          ctx.beginPath();
          for (let x = gw; x <= w - gw; x += 2) ctx.lineTo(x, yOf(decayAt(xOfInv(x), s)));
          for (let x = w - gw; x >= gw; x -= 2) ctx.lineTo(x, yOf(decayAt(xOfInv(x), s) * ceilGain));
          ctx.closePath();
          ctx.fillStyle = accent;
          ctx.globalAlpha = duckHot ? 0.2 : 0.11;
          ctx.fill();
          // the ghost: where the tail WOULD be with duck off — the ceiling only means something
          // against it, and the live line rests here at rest, not on a separate invisible value.
          ctx.beginPath();
          for (let x = gw; x <= w - gw; x += 2) ctx.lineTo(x, yOf(decayAt(xOfInv(x), s)));
          ctx.strokeStyle = accent;
          ctx.globalAlpha = duckHot ? 0.5 : 0.28;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          // the live line — bright exactly when it's doing something, near-invisible (it's sitting
          // on the ghost) when it isn't.
          ctx.beginPath();
          for (let x = gw; x <= w - gw; x += 2) ctx.lineTo(x, yOf(envAt(xOfInv(x), s, duckGain)));
          ctx.strokeStyle = "#fff";
          ctx.globalAlpha = 0.12 + 0.75 * duckPulse;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      // the dry hit itself — the source. It sits at x=gw: t=0 on the timeline's OWN coordinate
      // space (secToX(0) === gw exactly). ★ It PULSES with duckPulse now — the source glowing
      // brighter exactly when it's actually pushing the tail down, so the causality reads at a
      // glance: this bar lights up, that's why the tail just dipped.
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(gw, round(midY - maxBar), barW, round(maxBar * 2));
      if (duckPulse > 0.02) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = duckPulse * 0.9;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 4 + duckPulse * 10;
        ctx.fillStyle = accent;
        ctx.fillRect(gw - 1, round(midY - maxBar) - 1, barW + 2, round(maxBar * 2) + 2);
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = 1;

      // === THE TWO GUTTERS — DUCK on the left, DRIVE on the right.
      //
      // ★ THE LAW CHOSE THE HANDLE. Every vertical magnitude on this canvas now runs BOTTOM 0 → TOP
      // 100 (the taps already did; the wobble and the drive were still centring their maximum, which
      // is the same bipolar bug the taps were cured of). But a law that spans the full height needs a
      // handle that spans the full height — grab the FIRE, which lives at the top edge, and a
      // bottom-to-top law would slam it to 100% the instant you touched it. The handle and the law
      // have to agree or the control lies on touch-down.
      //
      // ★ RESERVED FOR REAL, NOT JUST REFEREED. secToX/xToSec (above) make gw..w-gw the timeline's
      // actual coordinate space now — an echo cannot land in a gutter's zone anymore, so there's
      // nothing left here for hit-test priority to referee. Which means the gutter doesn't need to
      // CLAIM every one of its gw pixels to be seen: the SAME split the taps already use (a 3px bar,
      // a 16px grab) — shrink what you look at, grow what you touch. A thin rail (always visible, so
      // the lane never reads as dead space) + a puck riding it at the current level. The full gw
      // stays the hit zone; only the paint got smaller, which is most of what was crowding the dry
      // hit in the first place.
      for (const [id, atLeft, v] of [["duck", true, dv], ["drive", false, heat]] as [string, boolean, number][]) {
        const on = hot === id;
        const lvl = botY - v * (botY - top);
        const railX = atLeft ? GUTTER_MARGIN : w - GUTTER_MARGIN - RAIL_W;
        ctx.fillStyle = accent;
        ctx.globalAlpha = on ? 0.22 : 0.12;
        ctx.fillRect(railX, top, RAIL_W, botY - top);
        // the puck — the level IS the value, riding the rail. Visible at zero too, or the lane
        // reads as a dead box you have to discover with the mouse.
        const puckH = on ? 9 : 7;
        const puckW = on ? PUCK_W + 2 : PUCK_W;
        ctx.globalAlpha = on ? 1 : 0.88;
        ctx.fillRect(railX + RAIL_W / 2 - puckW / 2, clamp(Math.round(lvl - puckH / 2), top, botY - puckH), puckW, puckH);
        ctx.globalAlpha = 1;
      }

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

      // THE DECAY GUIDE — the curve the tap tips ride. Without it the tail is a row of ever-shorter
      // bars fading into nothing, so "grab the tail and pull it up" means aiming at a 2px stub you
      // can barely see. It is a GUIDE now, not a handle: the duck moved to the dry hit, where there
      // was room for it.
      if (!s.frozen) {
        ctx.beginPath();
        for (let x = gw; x <= w - gw; x += 2) ctx.lineTo(x, midY - maxBar * envAt(xOfInv(x), s, duckGain));
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      ctx.shadowColor = "rgba(255,170,90,0.9)";
      ctx.shadowBlur = clamp01(s.drive) * 8;
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        const base = s.frozen ? 1 : Math.pow(clamp(s.feedback, 0, 0.999), n);
        if (!s.frozen && base < 0.02) break;
        const amp = envAt(ts, s, duckGain); // = fb^n × the LIVE duck gain — every tap breathes together
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
      ctx.fillText(`${fmtHz(s.hp)} – ${fmtHz(s.lp)}`, w - 5, ry);
      // the middle — the contextual "this is the thing in my hand"
      const pct = (v: number) => `${Math.round(clamp01(v) * 100)}%`;
      const ctxLabel =
        hot === "width" ? `WIDTH ${pct(s.width)}`
        : hot === "drive" ? `DRIVE ${pct(s.drive)}`
        : hot === "duck" ? `DUCK ${pct(s.duck)}`
        : hot === "lfo" ? `WOBBLE ${pct(modN)} · ${(beat > 0 && nameOf(1 / Math.max(1e-4, s.modRate) / beat, s.modSnapBeats, s.modSnapLabels)) || `${s.modRate.toFixed(2)} Hz`}`
        : hot === "hp" || hot === "lp" || hot === "band" ? `${fmtHz(s.hp)} Hz – ${fmtHz(s.lp)} Hz`
        // A tap's IDENTITY (which echo, n) is fixed for the whole gesture — grabbing echo 3 never
        // stops being echo 3 mid-drag. What actually moves is TIME (x) and FEEDBACK (y), together,
        // every frame. Naming the tap told you what you'd grabbed, not what pulling on it does —
        // and it never changed while the thing it's a proxy for kept changing under your hand.
        : hot === "tap" ? `TIME ${timeLabel} · FB ${Math.round(clamp01(s.feedback) * 100)}%`
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
      // ★ Duck's pulse is audio-reactive, not state-driven — nothing SETS it, so nothing calls
      // kick() when it changes. It only keeps animating if the loop keeps re-scheduling itself,
      // same as the wobble's own clock.
      const wobbling = clamp01(p.current.modDepth / MOD_MAX) > 0.001 && p.current.modRate > 0;
      const ducking = p.current.duck > 0.001;
      raf = wobbling || ducking || grab.current ? window.requestAnimationFrame(loop) : 0;
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
      const { ribbonH, ribY, top, botY, midY } = geom(h, w);
      if (py < ribY) return null; // the readout strip is a label, not a control
      if (py <= ribY + ribbonH) {
        const grip = w < NARROW_PX ? GRIP_PX * 1.6 : GRIP_PX; // a thumb is not a mouse
        const kind = hitFreqRibbon(px, py, { x: 0, y: ribY, w, h: ribbonH }, s.hp, s.lp, grip);
        if (kind) return { kind };
      }
      if (py < top || py > botY) return null;

      const t = Math.max(0.001, s.time);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const windowSec = windowOf(beat, w);
      // ★ PRIORITY. The GUTTERS come first and win outright — they are the only two handles on this
      // surface whose law spans the full height, so they need pixels nothing else can take. This is
      // now a belt-and-braces check, not the only thing stopping a tap landing here — secToX already
      // excludes this zone from the timeline's own coordinate space, so a tap can't geometrically
      // reach it any more either.
      //   the GUTTERS  — duck (left) and drive (right), full height, bottom 0 → top 100
      //   a TAP        — the primary gesture; it owns its ±grip of x, at any height
      //   the WOBBLE   — the centre band
      // The FIRE and the SHADOW are not in this list. They are what drive and duck DO; the gutters
      // are what you grab. An effect drawn at the top edge cannot also be a bottom-to-top fader.
      const gw = gutterOf(w);
      if (px <= gw) return { kind: "duck" };
      if (px >= w - gw) return { kind: "drive" };

      let best = -1;
      // The grip can never be wider than half the gap to the next tap, or neighbouring grips
      // overlap and you grab the wrong echo. At 1/16 in a two-bar window the taps are ~24px apart.
      const innerW = Math.max(1, w - 2 * gw);
      let bestD = Math.min(TAP_GRIP, Math.max(4, ((t / windowSec) * innerW) / 2));
      const shear = clamp01(s.width) * shearOf(t, windowSec, w);
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        // Only grab a tap you can SEE. An invisible one (decayed past the draw threshold) offered
        // absurd leverage — fb = amp^(1/n) with a big n turns a 2px nudge into a jump to 95%.
        const base = s.frozen ? 1 : Math.pow(clamp(s.feedback, 0, 0.999), n);
        if (!s.frozen && base < 0.02) break;
        // measure to the HALF you're actually over — the two channels are sheared apart
        const cx = secToX(ts, w, windowSec) + (py > midY ? shear : -shear);
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
        const rect = { x: 0, y: 0, w, h: 1 };
        if (g.kind === "hp") setFilters(dragHp(px, rect, s.lp, RIBBON_RANGE), s.lp);
        else setFilters(s.hp, dragLp(px, rect, s.hp, RIBBON_RANGE));
        return;
      }
      if (g.kind === "band") {
        const [nHp, nLp] = dragBand(px - g.lastX, { x: 0, y: 0, w, h: 1 }, s.hp, s.lp, RIBBON_RANGE);
        g.lastX = px;
        setFilters(nHp, nLp);
        return;
      }
      if (g.kind === "drive" || g.kind === "duck") {
        // ★ ONE LAW, and it is the same one the taps use: BOTTOM 0 → TOP 100, monotonic, absolute.
        // Both of these used to CENTRE their maximum — drive mirrored its roof around the axis, duck
        // read |py − midY| — which is the identical bipolar bug the taps were cured of: the middle
        // meant one thing, and both rails meant the same other thing, so nothing on the control said
        // which way was "more". The gutter's fill level IS the value, so the drag can be absolute
        // and the level lands under your finger.
        setChar(g.kind, (botY - py) / Math.max(1, botY - top));
        return;
      }
      if (g.kind === "lfo") {
        // ★ DEPTH runs BOTTOM 0 → TOP 100, like everything else that has a magnitude here. It used to
        // be |py − midY| — the distance from the centre line — so the middle was 0% and BOTH rails
        // were 100%: the same bipolar law the taps were cured of, still living in the wobble because
        // a wave really is symmetric about the axis. But the wave's SHAPE being symmetric doesn't
        // make its DEPTH bipolar. Depth has no negative half, and a control with no negative half
        // must not have a centre that means zero.
        const depth = clamp01((midY + maxBar - py) / Math.max(1, 2 * maxBar)) * MOD_MAX;
        // RATE is a STRETCH, and stretches are relative: drag right and the wave lengthens under
        // your hand (slower), left and it compresses (faster). Log-scaled, so one full-width drag
        // spans the whole 0.02‥8 Hz range and every octave of it feels the same width.
        // Stretched relative to the INNER span — the wave itself only spans gw..w-gw now, so the
        // drag that stretches it should be measured against the same span it's dragging.
        const innerWLfo = Math.max(1, w - 2 * gutterOf(w));
        const span = Math.log(RATE_MAX / RATE_MIN);
        const rate = clamp(g.startRate * Math.exp((-(px - g.startX) / innerWLfo) * span), RATE_MIN, RATE_MAX);
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
        const trueX = secToX((g.n + 1) * Math.max(0.001, s.time), w, windowSec);
        setChar("width", (px - trueX) / shearOf(Math.max(0.001, s.time), windowSec, w));
      } else {
        setTime(clamp(xToSec(px, w, windowSec) / (g.n + 1), 0.02, MAX_TIME));
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
      else if (hit.kind === "duck") grab.current = { kind: "duck" };
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

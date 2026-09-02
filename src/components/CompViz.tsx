import { useEffect, useRef, type ReactNode } from "react";
import type { Deck, CompFx } from "@htl/audio";

// The compressor's instrument — a transfer curve you GRAB (drag the bend for threshold+ratio,
// drag the knee to round it), not a row of number cells describing one.
//
//   • THE GR HISTORY is a WASH filling the plot from the ceiling down, drawn first so the grid,
//     the curve and the live dot all sit on top of it — the last ~4s of gain reduction as the
//     field's own weather, not a meter bolted on beside it.
//   • THE LIVE DOT rides the curve at (own level, own level − live GR). Under SC:INT that lands
//     back on the curve, because the detector agrees with what's on screen. Under SC:EXT it
//     doesn't — a hollow ring marks where the dot would sit from its OWN level, a dashed line
//     connects it to where it actually is, and that gap IS the sidechain, made visible instead of
//     asserted by a label.
//   • THE SC-HP/LP RIBBON IS NOT HERE. It lives in CompHead, the full-panel-width strip above
//     this row, because a frequency ruler has to span the panel to line its 20 Hz / 1 k / 20 k up
//     with every other ribbon in the rack — and this canvas is the MIDDLE column of three. See
//     CompHead.tsx for the whole argument.
//
// The own-level trace is read from real audio (an AnalyserNode on the device's own input) — the
// gain reduction itself comes straight from the worklet's real detector, filtered sidechain and
// all, so the dot's divergence from the curve needs no separate approximation of the sidechain.
// ATTACK/RELEASE is its own small XY pad (CompArPad), to the LEFT of this canvas — the curve has
// exactly one axis pair (input dB → output dB) and ballistics have none of their own.
//
// ★ `dev` is re-fetched from deck.fxDeviceAt(slot) at the TOP of every draw()/hit-test/drag call,
// never captured once and closed over — the one thing DelayViz's own draw loop does that this
// component's siblings (GateViz/SatViz/NoiseViz/CrushViz/ModViz) don't. Cheap, and it means a
// stale device reference can never silently freeze the picture.

interface CompVizProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
  setHot: (v: string | null) => void; // names the control under the pointer — see CompHead
  left?: ReactNode; // the ATTACK/RELEASE pad, rendered before the canvas
  children?: ReactNode; // the side column (MAKEUP/LOOK), rendered after the canvas
}

const DB_MIN = -60,
  DB_MAX = 0;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Ratio has no natural position on the bend handle — the bend always sits ON the 1:1 diagonal at
// (threshold, threshold), whatever the ratio is, so its vertical position can never STAND FOR
// ratio the way an EQ node's height stands for gain (the law DelayViz's own comments spell out:
// "a handle may only be dragged absolutely if its position actually stands for the value"). So
// ratio rides a RELATIVE vertical drag, same idiom as ValueCell's own knob gesture — up = more,
// down = less, independent of where the drag started.
// Under this the plot stops carrying its optional furniture (axis names, the ratio caption) —
// on a phone those are the first things to collide with the handles they sit between.
const NARROW_PLOT_PX = 250;

// ★ ONE definition of the plot's padding, shared by the draw loop, the hit-test, the hover test
// and the drag. It became width-dependent when the left gutter had to hold a meter as well as the
// dB scale, and a hit-test still computing `l: 28` against a plot drawn at `l: 32` would put every
// handle six pixels away from where you can see it — the class of bug this file's own comments
// keep warning about ("the control lies about where the value actually is").
function padOf(w: number, h: number) {
  const narrow = w < NARROW_PLOT_PX;
  void h;
  return { l: narrow ? 26 : 32, r: 6, t: 8, b: narrow ? 9 : 13 };
}

/** ★ WHERE MAKEUP LIVES ON THE PLOT: the curve's own output end, at full-scale input.
 *  The curve is drawn WITH makeup folded in (outputDb), so that point already moves up and down
 *  by exactly the makeup — it was a control the panel was drawing and not letting you touch.
 *  Pulled slightly inside the right edge so the handle is never half off-canvas. */
function makeupHandle(w: number, h: number, cp: { thresh: number; ratio: number; knee: number; makeup: number; mix: number }) {
  const PAD = padOf(w, h);
  const plotBottom = h - PAD.b;
  const inDb = DB_MAX - 1.5;
  const x = PAD.l + ((inDb - DB_MIN) / (DB_MAX - DB_MIN)) * (w - PAD.l - PAD.r);
  const outDb = clamp(outputDb(inDb, cp as CurveParams), DB_MIN, DB_MAX);
  const y = PAD.t + ((DB_MAX - outDb) / (DB_MAX - DB_MIN)) * (plotBottom - PAD.t);
  return { x, y };
}

const RATIO_DRAG_PX = 160;
const RATIO_MIN = 1,
  RATIO_MAX = 20;

// Soft-knee transfer: input dB → output dB. Pure, so both the draw loop and the live dot share
// exactly one definition of "what this curve does" — the picture can't drift from the math.
// A handle's label goes BELOW it, clear of its outer ring — unless the handle is low enough that
// "below" would be clamped back onto the ring, in which case it flips above. Clamping a label to
// the plot's edge without flipping it is what put THRESH on top of its own circle: at a low
// threshold the two collided and neither was legible.
function labelY(cy: number, ringR: number, top: number, bottom: number, side: "above" | "below"): number {
  const below = cy + ringR + 11;
  const above = cy - ringR - 6;
  if (side === "below") return below <= bottom - 2 ? below : Math.max(top + 8, above);
  return above >= top + 8 ? above : Math.min(bottom - 2, below);
}

// ★ WHAT THE DEVICE ACTUALLY DOES TO A LEVEL — transfer() is only the DETECTOR's half of it.
// The worklet then adds makeup (compWorklet.ts:116) and the device crossfades the result against
// the dry signal (CompFx.applyDry — an insert, so mix < 1 IS parallel compression). The curve used
// to draw transfer() alone, which made it wrong by the makeup and wrong again by the mix, and
// AUTO makeup is ON BY DEFAULT and derived from threshold × ratio: at thresh −40 / ratio 17.7 it
// is +20.8 dB, so the biggest thing on the panel was drawn 21 dB below the truth. Every consumer
// of this picture — the polyline, both handles, and the hit-tests that must land on them — goes
// through this one function.
export interface CurveParams {
  thresh: number;
  ratio: number;
  knee: number;
  makeup: number; // total, auto-makeup already folded in
  mix: number;
}

function curveParamsOf(dev: CompFx): CurveParams {
  // LIMIT hardwires its own ballistics in the worklet (ratio ≈ 1000:1, knee ≈ 1), bites at
  // CEILING rather than THRESHOLD, and takes NO auto-makeup — a limiter must never invent gain.
  const isLimit = Math.round(dev.getParam("mode")) === 3;
  const rawThresh = dev.getParam("threshold");
  const rawRatio = dev.getParam("ratio");
  const makeupDb = dev.getParam("makeup");
  return {
    thresh: isLimit ? dev.getParam("ceiling") : rawThresh,
    ratio: isLimit ? 1000 : rawRatio,
    knee: isLimit ? 1 : dev.getParam("knee"),
    // Mirrors compWorklet.ts:116 exactly, including that it reads the STORED threshold/ratio and
    // not LIMIT's substituted ones.
    makeup: isLimit || dev.getParam("auto") < 0.5 ? makeupDb : makeupDb + -rawThresh * (1 - 1 / Math.max(1, rawRatio)) * 0.55,
    mix: dev.getParam("mix"),
  };
}

const lin = (db: number) => Math.pow(10, db / 20);

function outputDb(inDb: number, p: CurveParams): number {
  const wet = transfer(inDb, p.thresh, p.ratio, p.knee) + p.makeup;
  if (p.mix >= 0.999) return wet;
  // The two legs are the same signal at two gains, so they sum coherently — an amplitude blend,
  // not a power one.
  return 20 * Math.log10(Math.max(1e-9, (1 - p.mix) * lin(inDb) + p.mix * lin(wet)));
}

function transfer(inDb: number, thresh: number, ratio: number, knee: number): number {
  const kneeLo = thresh - knee / 2,
    kneeHi = thresh + knee / 2;
  if (inDb <= kneeLo) return inDb;
  if (inDb >= kneeHi) return thresh + (inDb - thresh) / ratio;
  const t = (inDb - kneeLo) / (knee || 1e-6);
  const slope = 1 - 1 / ratio;
  return inDb - (slope * (inDb - kneeLo) * t) / 2;
}

type DragState = { kind: "bend"; startY: number; startRatio: number } | { kind: "knee" } | { kind: "makeup"; startY: number; startMakeup: number };

export function CompViz({ deck, slot, accent, set, setHot, left, children }: CompVizProps) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<DragState | null>(null);
  const hover = useRef<"bend" | "knee" | "makeup" | null>(null);

  useEffect(() => {
    const canvas = mainRef.current;
    const dev0 = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!canvas || !dev0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Only the device's OWN input needs tapping — the worklet's real gainReduction already
    // reflects whatever the sidechain (filtered, external or not) actually did. Approximating
    // that detector a second time in JS would be a second, less honest copy of the same number.
    const actx = dev0.output.context;
    const ownAn = actx.createAnalyser();
    ownAn.fftSize = 512;
    dev0.input.connect(ownAn);
    const ownBuf = new Float32Array(ownAn.fftSize) as Float32Array<ArrayBuffer>;

    const peakDb = (an: AnalyserNode, buf: Float32Array<ArrayBuffer>) => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
      return peak > 1e-6 ? 20 * Math.log10(peak) : -80;
    };

    const HIST_LEN = 240; // ~4s at 60fps
    const history = new Array(HIST_LEN).fill(0);

    // ★ METER BALLISTICS. The worklet's gainReduction is a per-block instantaneous number: read
    // it raw at 60fps and print it as text and it flickers through every digit, which is what
    // made the on-graph readout unusable. Real meters have never shown the instantaneous value —
    // they attack fast (you must see the hit land) and release slowly (you must be able to READ
    // it), with a peak hold that falls slower still. Same law here.
    let grSmooth = 0;
    let grPeak = 0;
    let inSmooth = DB_MIN;
    let inPeak = DB_MIN;

    let raf = 0;
    const draw = () => {
      const dev = (deck.fxDeviceAt(slot) as CompFx | undefined) ?? dev0;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // LIMIT hardwires its own ballistics in the worklet (ratio≈1000:1, knee≈1) and the corner it
      // actually bites at is CEILING, not THRESHOLD — drawing the user's stored threshold/ratio/
      // knee here would show a curve the DSP isn't running. Mirror computeGr's own mode branch.
      const isLimit = Math.round(dev.getParam("mode")) === 3;
      const cp = curveParamsOf(dev);
      const { thresh, ratio, knee } = cp;
      const scExt = dev.getParam("scExt") >= 0.5;
      const gr = dev.gainReduction;

      // ── geometry: the plot owns the whole canvas, minus a LEFT GUTTER that carries both the
      // dB scale and the gain-reduction meter (see below) ──────────────────────────────────
      const narrow = w < NARROW_PLOT_PX;
      const PAD = padOf(w, h);
      const plotBottom = h - PAD.b;
      const dbToX = (db: number) => PAD.l + ((db - DB_MIN) / (DB_MAX - DB_MIN)) * (w - PAD.l - PAD.r);
      const dbToY = (db: number) => PAD.t + ((DB_MAX - db) / (DB_MAX - DB_MIN)) * (plotBottom - PAD.t);

      // ── live level — real audio, not simulated. `gr` (the worklet's own detector) already
      // reflects whatever the sidechain actually did, filtered or not — the dot's divergence
      // from the curve is the truth, not an approximation of it.
      const ownDb = peakDb(ownAn, ownBuf);

      grSmooth += (gr - grSmooth) * (gr > grSmooth ? 0.55 : 0.08);
      grPeak = gr >= grPeak ? gr : Math.max(gr, grPeak - 0.12);
      inSmooth += (ownDb - inSmooth) * (ownDb > inSmooth ? 0.6 : 0.09);
      inPeak = ownDb >= inPeak ? ownDb : Math.max(ownDb, inPeak - 0.35);

      history.push(gr);
      if (history.length > HIST_LEN) history.shift();

      // ── GR history wash — the plot's own weather, drawn first ────────────────────────────
      {
        const scale = 24;
        const maxFrac = 0.62;
        const plotW = w - PAD.l - PAD.r;
        const plotH = plotBottom - PAD.t;
        const stepX = plotW / (HIST_LEN - 1);
        const levelY = (v: number) => PAD.t + Math.min(maxFrac, v / scale) * plotH;

        ctx.beginPath();
        ctx.moveTo(PAD.l, PAD.t);
        for (let i = 0; i < HIST_LEN; i++) ctx.lineTo(PAD.l + i * stepX, levelY(history[i]));
        ctx.lineTo(PAD.l + plotW, PAD.t);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + maxFrac * plotH);
        grad.addColorStop(0, `color-mix(in srgb, ${accent} 30%, transparent)`);
        grad.addColorStop(1, `color-mix(in srgb, ${accent} 2%, transparent)`);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < HIST_LEN; i++) {
          const y = levelY(history[i]);
          if (i === 0) ctx.moveTo(PAD.l, y);
          else ctx.lineTo(PAD.l + i * stepX, y);
        }
        ctx.strokeStyle = `color-mix(in srgb, ${accent} 55%, transparent)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // ── grid ──────────────────────────────────────────────────────────────────────────────
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      for (let db = -60; db <= 0; db += 10) {
        const x = dbToX(db);
        ctx.beginPath();
        ctx.moveTo(x, PAD.t);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }
      for (let db = -60; db <= 0; db += 20) {
        const y = dbToY(db);
        ctx.beginPath();
        ctx.moveTo(PAD.l, y);
        ctx.lineTo(w - PAD.r, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.font = "8px ui-monospace, monospace";
        ctx.textAlign = "right";
        ctx.fillText(String(db), PAD.l - 9, y + 3);
      }
      // ── THE GAIN-REDUCTION METER, in the axis gutter. It hangs DOWN from 0 dB on the plot's
      // OWN scale, so the bar's length and the curve's vertical squash are literally the same
      // measurement — read straight across and the meter's foot sits at the output level the
      // curve is producing. This is where a compressor's GR meter has always lived; it was a
      // number floating over the plot, jittering through every digit at 60fps and moving around
      // under the music, which is unreadable and covers the curve besides.
      {
        const mx = PAD.l - 6,
          mw = 4;
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(mx, PAD.t, mw, plotBottom - PAD.t);
        // Working-range ticks. The meter shares the plot's 60 dB axis — which is what lets you
        // read its foot straight across to the curve — but real buss compression lives in the
        // first 3-12 dB of that, about a sixth of the track. The ticks give that sixth some
        // resolution without giving the meter a second, disagreeing scale.
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        for (const d of [3, 6, 12]) ctx.fillRect(mx - 2, dbToY(DB_MAX - d), 2, 1);
        // ★ SC:EXT COLOURS THE METER. The old dot said this by LEAVING the curve — a divergence
        // you could only read while audio was playing and the gap happened to be wide enough to
        // notice. But "who is driving this compressor" is a permanent fact about the patch, not
        // an event, so it belongs on the thing being driven: under EXT the reduction is coming
        // from the other deck, and the bar showing that reduction turns sidechain-cyan and stays
        // that way whether or not anything is playing.
        const meterCol = scExt ? "#4ad0ff" : accent;
        const yTop = dbToY(DB_MAX);
        const yNow = dbToY(clamp(DB_MAX - grSmooth, DB_MIN, DB_MAX));
        if (yNow - yTop > 0.5) {
          const g = ctx.createLinearGradient(0, yTop, 0, yNow);
          g.addColorStop(0, meterCol);
          g.addColorStop(1, `color-mix(in srgb, ${meterCol} 45%, transparent)`);
          ctx.fillStyle = g;
          ctx.fillRect(mx, yTop, mw, yNow - yTop);
        }
        // peak hold — falls slower than the bar, so a transient you'd otherwise miss leaves a
        // mark you can actually read.
        if (grPeak > 0.3) {
          ctx.fillStyle = "#fff";
          ctx.globalAlpha = 0.75;
          ctx.fillRect(mx, dbToY(clamp(DB_MAX - grPeak, DB_MIN, DB_MAX)) - 1, mw, 1.5);
          ctx.globalAlpha = 1;
        }
      }

      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(dbToX(DB_MIN), dbToY(DB_MIN));
      ctx.lineTo(dbToX(DB_MAX), dbToY(DB_MAX));
      ctx.stroke();
      ctx.setLineDash([]);

      // ── the curve — thickness + glow breathe with live GR ────────────────────────────────
      const curveW = 2 + Math.min(5, grSmooth * 0.35);
      ctx.beginPath();
      for (let db = DB_MIN; db <= DB_MAX; db += 0.5) {
        const x = dbToX(db),
          y = dbToY(clamp(outputDb(db, cp), DB_MIN, DB_MAX));
        if (db === DB_MIN) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = curveW;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 4 + Math.min(18, grSmooth * 1.1);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ── the handles, PERMANENTLY NAMED. Reverb's dome learned this the hard way: naming was
      // hover-only in its first version, and an unlabelled dot is a dot. A compressor's two grips
      // do completely different things and neither is guessable from a circle.
      ctx.font = "700 7px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";

      // knee handle — LIMIT's knee is hardwired (~1dB) and not a user control, so there's
      // nothing here to grab in that mode.
      if (!isLimit) {
        const kneeDb = thresh + knee / 2;
        const kp = { x: dbToX(kneeDb), y: dbToY(clamp(outputDb(kneeDb, cp), DB_MIN, DB_MAX)) };
        const on = hover.current === "knee" || drag.current?.kind === "knee";
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, on ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = on ? "#fff" : "rgba(255,255,255,0.5)";
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${on ? 0.85 : 0.32})`;
        // KNEE goes ABOVE its dot and THRESH BELOW its ring — deliberately opposite sides. The
        // two handles sit within a few dB of each other by definition (the knee IS the threshold
        // plus half the knee width), so on a narrow panel same-side labels landed on top of one
        // another every time. Opposite sides makes that collision structurally impossible.
        ctx.fillText("KNEE", clamp(kp.x, PAD.l + 14, w - PAD.r - 14), labelY(kp.y, on ? 5.5 : 4, PAD.t, plotBottom, "above"));
      }

      // bend handle — threshold + ratio, or (in LIMIT) the ceiling alone
      const bendOn = hover.current === "bend" || drag.current?.kind === "bend";
      const bp = { x: dbToX(thresh), y: dbToY(clamp(outputDb(thresh, cp), DB_MIN, DB_MAX)) };
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, bendOn ? 6.5 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, bendOn ? 10 : 8.5, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = bendOn ? 1.6 : 1;
      ctx.stroke();
      ctx.fillStyle = bendOn ? "#fff" : `color-mix(in srgb, ${accent} 70%, transparent)`;
      ctx.fillText(isLimit ? "CEILING" : "THRESH", clamp(bp.x, PAD.l + 18, w - PAD.r - 18), labelY(bp.y, bendOn ? 10 : 8.5, PAD.t, plotBottom, "below"));

      // ── MAKEUP, on the end of the curve it moves. It gets the quietest treatment of the three
      // handles on purpose: THRESH and KNEE are shaping gestures you hunt for mid-mix, makeup is
      // a level you set once and leave. A hollow ring rather than a filled dot, and its label only
      // while you are near it — the plot has to stay readable as an instrument, not become a
      // control panel with three shouting dots.
      {
        const mkOn = hover.current === "makeup" || drag.current?.kind === "makeup";
        const mp = makeupHandle(w, h, cp);
        ctx.beginPath();
        ctx.arc(mp.x, mp.y, mkOn ? 6 : 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = mkOn ? "#fff" : `color-mix(in srgb, ${accent} 55%, transparent)`;
        ctx.lineWidth = mkOn ? 1.8 : 1.2;
        ctx.stroke();
        if (mkOn) {
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.textAlign = "right";
          ctx.fillText("MAKEUP", clamp(mp.x - 9, PAD.l + 26, w - PAD.r), labelY(mp.y, 6, PAD.t, plotBottom, "above"));
          ctx.textAlign = "center";
        }
      }

      // ── THE RATIO, WRITTEN ON THE THING RATIO ACTUALLY IS: the slope of the segment above the
      // knee. A number floating anywhere else in the panel is a number; sitting on the flattened
      // limb, at its own angle, it says WHICH LINE it governs — and the vertical drag that sets
      // it is on the bend handle right below.
      const a = thresh + knee / 2 + 2;
      const bx = dbToX(DB_MAX),
        by = dbToY(clamp(outputDb(DB_MAX, cp), DB_MIN, DB_MAX));
      const ax = dbToX(a),
        ay = dbToY(clamp(outputDb(a, cp), DB_MIN, DB_MAX));
      // Sat at 55% ALONG the limb. Not the midpoint — that lands on the knee handle and its label
      // when the limb is short. Not further out either: the limb's END now carries the MAKEUP
      // ring, and the same law that separated THRESH from KNEE applies here — two things that
      // ride the same line have to be given room on it deliberately, or they collide at exactly
      // the width where there is least of it. Skipped outright when the limb is too short to hold
      // the caption without covering the thing it describes.
      if (!isLimit && Math.hypot(bx - ax, by - ay) > 64) {
        ctx.save();
        ctx.translate(ax + (bx - ax) * 0.55, ay + (by - ay) * 0.55);
        ctx.rotate(Math.atan2(by - ay, bx - ax));
        ctx.fillStyle = `color-mix(in srgb, ${accent} 85%, transparent)`;
        ctx.font = "800 8px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(`${ratio.toFixed(1)}:1`, 0, -6);
        ctx.restore();
      }

      // ── INPUT LEVEL, in the BOTTOM gutter — the x-axis mirror of the GR meter in the left
      // one. The plot's x IS input dB, so a bar growing left-to-right along that axis needs no
      // scale of its own: read up from its head to the curve and you have the output.
      //
      // ★ THIS REPLACED A LIVE DOT ON THE CURVE. A point is the twitchiest possible way to draw
      // a peak follower — it has no mass, so every block-to-block wobble is full-amplitude motion
      // across two axes at once, and the eye can't help tracking it. The information was fine;
      // the FORM was wrong. A bar moves along ONE axis, carries the same ballistics as the GR
      // meter (fast attack, slow release, slower peak hold), and reads as a level rather than as
      // something darting about. Both gutters now do the same job in the same language: y = what
      // the compressor is taking, x = what it is being given.
      {
        const my = plotBottom + 3,
          mh = narrow ? 2.5 : 3;
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(PAD.l, my, w - PAD.l - PAD.r, mh);
        const x0 = dbToX(DB_MIN);
        const xNow = dbToX(clamp(inSmooth, DB_MIN, DB_MAX));
        if (xNow - x0 > 0.5) {
          const g = ctx.createLinearGradient(x0, 0, xNow, 0);
          g.addColorStop(0, `color-mix(in srgb, ${accent} 35%, transparent)`);
          g.addColorStop(1, accent);
          ctx.fillStyle = g;
          ctx.fillRect(x0, my, xNow - x0, mh);
        }
        if (inPeak > DB_MIN + 0.5) {
          ctx.fillStyle = "#fff";
          ctx.globalAlpha = 0.7;
          ctx.fillRect(dbToX(clamp(inPeak, DB_MIN, DB_MAX)) - 0.75, my, 1.5, mh);
          ctx.globalAlpha = 1;
        }
      }

      // axis names — the plot is dB-in against dB-out and nothing said so. Furniture, though:
      // on a narrow panel they crowd the scale and the curve's own right-hand end, and the axes
      // are already implied by the numbers running down the gutter.
      if (!narrow) {
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.font = "7px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "right";
        // ABOVE the baseline now, not below it — the bottom gutter belongs to the input meter.
        ctx.fillText("IN dB →", w - PAD.r - 2, plotBottom - 3);
        ctx.textAlign = "left";
        ctx.fillText("OUT", 2, PAD.t + 7);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      try {
        dev0.input.disconnect(ownAn);
      } catch {
        /* ignore */
      }
    };
  }, [deck, slot, accent]);

  // ── gestures ────────────────────────────────────────────────────────────────────────────
  // hit-testing needs the same geometry the draw loop uses — recomputed here from the canvas's
  // OWN rect rather than shared state, since it only runs on a press, not every frame.
  const hitTest = (e: React.PointerEvent): DragState | null => {
    const canvas = mainRef.current;
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!canvas || !dev) return null;
    const r = canvas.getBoundingClientRect();
    const w = r.width,
      h = r.height;
    const x = e.clientX - r.left,
      y = e.clientY - r.top;

    const PAD = padOf(w, h);
    const plotBottom = h - PAD.b;
    const dbToX = (db: number) => PAD.l + ((db - DB_MIN) / (DB_MAX - DB_MIN)) * (w - PAD.l - PAD.r);
    const dbToY = (db: number) => PAD.t + ((DB_MAX - db) / (DB_MAX - DB_MIN)) * (plotBottom - PAD.t);
    const isLimit = Math.round(dev.getParam("mode")) === 3;
    const cp = curveParamsOf(dev);
    if (!isLimit) {
      // ★ NEAREST HANDLE WINS — it cannot be "knee first, within 16px".
      //
      // The knee IS the threshold plus half the knee width, so the two handles sit within a few dB
      // of each other BY DEFINITION. The labels were already split above/below to stop them
      // colliding; the hit targets were not. Narrow the panel and the dB-per-pixel shrinks until
      // both handles map to almost the same x — at which point a fixed 16px knee circle tested
      // first swallows the threshold handle whole, and THRESH becomes unclickable exactly when the
      // panel is smallest. (Reported on a phone: "the threshold button right next to the knee
      // overlaps and is near impossible to click.")
      //
      // Comparing distances instead means the closer handle always answers. Two handles on top of
      // each other still split the space between them rather than one eating the other, so
      // whichever side of the midpoint you touch is the one you get.
      const kneeDb = cp.thresh + cp.knee / 2;
      const kp = { x: dbToX(kneeDb), y: dbToY(clamp(outputDb(kneeDb, cp), DB_MIN, DB_MAX)) };
      const bp = { x: dbToX(cp.thresh), y: dbToY(clamp(outputDb(cp.thresh, cp), DB_MIN, DB_MAX)) };
      const dKnee = Math.hypot(x - kp.x, y - kp.y);
      const dBend = Math.hypot(x - bp.x, y - bp.y);
      if (dKnee < 16 && dKnee <= dBend) return { kind: "knee" };
    }
    // ★ MAKEUP IS THE CURVE'S OUTPUT END. The plot already draws the curve WITH makeup folded in
    // (see outputDb), so the height of its right-hand end IS the makeup, on screen, always. It
    // needed no new representation — only a handle, on the thing it was already moving.
    const mp = makeupHandle(w, h, cp);
    if (Math.hypot(x - mp.x, y - mp.y) < 18) {
      return { kind: "makeup", startY: e.clientY, startMakeup: dev.getParam("makeup") };
    }
    return { kind: "bend", startY: e.clientY, startRatio: dev.getParam("ratio") }; // no dead zone
  };

  const applyDrag = (e: React.PointerEvent) => {
    const canvas = mainRef.current;
    const d = drag.current;
    if (!canvas || !d) return;
    const r = canvas.getBoundingClientRect();
    const w = r.width,
      h = r.height;
    const x = e.clientX - r.left;
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!dev) return;

    const PAD = padOf(w, h);
    const xToDb = (px: number) => DB_MIN + ((px - PAD.l) / (w - PAD.l - PAD.r)) * (DB_MAX - DB_MIN);
    const isLimit = Math.round(dev.getParam("mode")) === 3;

    if (d.kind === "bend") {
      if (isLimit) {
        // LIMIT drags CEILING alone — ratio/knee are hardwired in the worklet, so there's
        // nothing for a second axis to mean here.
        set("ceiling", clamp(xToDb(x), -12, 0));
        return;
      }
      set("threshold", clamp(xToDb(x), DB_MIN + 4, -1));
      // RELATIVE, not absolute — see the RATIO_DRAG_PX comment: the bend handle's own position
      // never stands for ratio (it always sits on the diagonal), so the only law that can work
      // here is "up = more, down = less", from wherever the gesture started.
      const dy = d.startY - e.clientY;
      set("ratio", clamp(d.startRatio + (dy / RATIO_DRAG_PX) * (RATIO_MAX - RATIO_MIN), RATIO_MIN, RATIO_MAX));
    } else if (d.kind === "knee" && !isLimit) {
      const thresh = dev.getParam("threshold");
      set("knee", clamp((xToDb(x) - thresh) * 2, 0, 24));
    } else if (d.kind === "makeup") {
      // Vertical, in the plot's OWN dB — drag the end of the curve to where you want it and the
      // number follows, rather than the number moving and the curve following it.
      const PAD2 = padOf(w, h);
      const dbPerPx = (DB_MAX - DB_MIN) / Math.max(1, h - PAD2.t - PAD2.b);
      set("makeup", clamp(d.startMakeup + (d.startY - e.clientY) * dbPerPx, -12, 24));
    }
  };

  // Which handle the pointer is NEAR — for hover naming and the grow-on-approach affordance.
  // Deliberately NOT hitTest(): that one has no dead zone (a press anywhere grabs the bend, which
  // is right for a gesture and wrong for a label — "you are hovering THRESH" 400px from it is a
  // lie).
  const near = (e: React.PointerEvent): "bend" | "knee" | "makeup" | null => {
    const canvas = mainRef.current;
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!canvas || !dev) return null;
    const r = canvas.getBoundingClientRect();
    const w = r.width,
      h = r.height;
    const x = e.clientX - r.left,
      y = e.clientY - r.top;
    const PAD = padOf(w, h);
    const plotBottom = h - PAD.b;
    const dbToX = (db: number) => PAD.l + ((db - DB_MIN) / (DB_MAX - DB_MIN)) * (w - PAD.l - PAD.r);
    const dbToY = (db: number) => PAD.t + ((DB_MAX - db) / (DB_MAX - DB_MIN)) * (plotBottom - PAD.t);
    const isLimit = Math.round(dev.getParam("mode")) === 3;
    const cp = curveParamsOf(dev);
    if (!isLimit) {
      const kneeDb = cp.thresh + cp.knee / 2;
      if (Math.hypot(x - dbToX(kneeDb), y - dbToY(clamp(outputDb(kneeDb, cp), DB_MIN, DB_MAX))) < 16) return "knee";
    }
    const mp = makeupHandle(w, h, cp);
    if (Math.hypot(x - mp.x, y - mp.y) < 18) return "makeup";
    return Math.hypot(x - dbToX(cp.thresh), y - dbToY(clamp(outputDb(cp.thresh, cp), DB_MIN, DB_MAX))) < 26 ? "bend" : null;
  };

  // The middle readout zone, written every frame of a gesture. HELD → the live value; HOVERED →
  // the GESTURE ITSELF, with its axis, because "what does this do and when do I touch it" is a
  // question you have before you drag, not after.
  const report = () => {
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!dev) return;
    const isLimit = Math.round(dev.getParam("mode")) === 3;
    const d = drag.current;
    if (d?.kind === "bend") {
      setHot(isLimit ? `CEILING ${dev.getParam("ceiling").toFixed(1)} dB` : `THRESH ${dev.getParam("threshold").toFixed(1)} dB  ·  RATIO ${dev.getParam("ratio").toFixed(1)}:1`);
    } else if (d?.kind === "knee") {
      setHot(`KNEE ${dev.getParam("knee").toFixed(1)} dB`);
    } else if (d?.kind === "makeup") {
      const m = dev.getParam("makeup");
      setHot(`MAKEUP ${m > 0 ? "+" : ""}${m.toFixed(1)} dB`);
    } else if (hover.current === "bend") {
      setHot(isLimit ? "CEILING  ⇄  drag" : "THRESH ⇄   ·   RATIO ⇅");
    } else if (hover.current === "knee") {
      setHot("KNEE  ⇄  soften the corner");
    } else if (hover.current === "makeup") {
      setHot("MAKEUP  ⇅  lift the whole output");
    } else {
      setHot(null);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    const d = hitTest(e);
    if (!d) return;
    drag.current = d;
    mainRef.current?.setPointerCapture(e.pointerId);
    applyDrag(e);
    report();
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) applyDrag(e);
    else hover.current = near(e);
    report();
  };
  // ── RESET, the gesture every other control in this rack has and this one lost when the ribbon
  // moved out of this canvas: double-click (or right-click, matching ReverbViz's own grips) puts
  // the handle you're on back to its default. Away from both handles it resets the whole curve.
  // A control you can dial but not undial is a control you experiment with once.
  const resetAt = (e: React.MouseEvent) => {
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!dev) return;
    if (Math.round(dev.getParam("mode")) === 3) return set("ceiling", -0.3);
    const which = near(e as unknown as React.PointerEvent);
    if (which === "knee") return set("knee", 6);
    if (which !== "bend") set("knee", 6);
    set("threshold", -18);
    set("ratio", 4);
  };
  const onDoubleClick = (e: React.MouseEvent) => resetAt(e);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    resetAt(e);
  };

  const onUp = (e: React.PointerEvent) => {
    drag.current = null;
    hover.current = null;
    setHot(null);
    try {
      mainRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="fx-viz-row">
      {left}
      <div className="sat-viz">
        <canvas ref={mainRef} className="sat-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
      </div>
      {children}
    </div>
  );
}

// The frequency-band ribbon — a horizontal strip on a log-Hz scale showing a low/high cut
// window as a plateau with sloped shoulders (a response curve, not a progress bar): drag an
// EDGE to move one cut, drag the BODY to sweep both together (the band keeps its width). Built
// for the delay's tap timeline, now shared with the reverb's dome — one control, drawn and hit
// the same way everywhere it appears, instead of two hand-derived copies drifting apart.
//
// RESONANCE: each grip also carries a vertical axis (drag the grip up/down while dragging it
// left/right, same two-axis gesture as the EQ's own cut nodes) — drawn as a resonant PEAK right
// at that corner, rising out of the plateau's own outline, because that is what a resonant
// filter's magnitude response actually looks like there. The ribbon only ever deals in 0..1
// FRACTIONS for this (hpResFrac/lpResFrac) — converting a fraction to an actual Q value, and
// deciding what range is even SAFE (Delay's HP/LP sit inside a feedback loop; Reverb's don't),
// is entirely the caller's business. See fxDsp.ts's qToFrac/fracToQ (the same engine EQ's own
// resonance rail uses) for that conversion.

export interface RibbonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The cuts may not cross (or meet) — a band that isn't a band is just a mute. Each caller owns
// its own device's real bounds; this primitive only enforces "stay a band" within them.
//
// loMin/loMax and hiMin/hiMax are SEPARATE, not one shared range — the delay's cuts happen to
// share one (loMin=hiMin=20, loMax=hiMax=18000), but the reverb's tail window doesn't: its DSP
// hard-clamps lowCut to [20,2000] and highCut to [1000,20000] (ReverbFx.ts). A shared range would
// let a grip drift somewhere past 2000 Hz that the DSP silently clamps back from underneath it —
// the exact "the control lies about where the value actually is" bug this codebase keeps finding
// and killing (htl-webaudio-footguns). Passing the device's REAL asymmetric bounds is the fix.
export interface RibbonRange {
  loMin: number;
  loMax: number;
  hiMin: number;
  hiMax: number;
  minRatio: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const F0 = 20; // the log scale's floor — 20 Hz .. 20 kHz, three decades
const F1 = 20000;
const SPAN = Math.log(F1 / F0);

export const fToX = (f: number, w: number) => (Math.log(clamp(f, F0, F1) / F0) / SPAN) * w;
export const xToF = (x: number, w: number) => F0 * Math.exp((clamp(x, 0, w) / w) * SPAN);
export const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);

export type RibbonHot = "hp" | "lp" | "band" | null;

// Paints the ruler + band + grips into `rect`. Caller has already cleared/positioned the canvas;
// this only translates to rect.x/rect.y and draws within rect.w × rect.h. hpResFrac/lpResFrac
// (0..1, 0 = flat) are each grip's OWN resonance — drawn as a peak rising out of the plateau
// right at that corner.
export function drawFreqRibbon(ctx: CanvasRenderingContext2D, rect: RibbonRect, lo: number, hi: number, accent: string, hot: RibbonHot, hpResFrac = 0, lpResFrac = 0) {
  const { w, h } = rect;
  ctx.save();
  ctx.translate(rect.x, rect.y);
  const loX = fToX(lo, w);
  const hiX = fToX(hi, w);
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0, 0, w, h);

  // A SPECTRUM RULER — decade ticks only, no text; the Hz live in whichever readout owns this
  // control, so a caption here would just be a second place the numbers can hide.
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.lineWidth = 1;
  for (const f of [100, 1000, 10000]) {
    const x = Math.round(fToX(f, w)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // The band is drawn as the filter it is — a plateau with sloped shoulders, not a rectangle. A
  // rectangle reads as a progress bar (how full?); a shape with skirts reads as a response curve
  // (what gets through?) — which is the actual question. RESONANCE extends that same idea: a
  // real resonant HP/LP doesn't just roll off at the corner, it PEAKS there first — so a grip
  // with resonance dialled in gets an actual peak in the outline, at that corner, instead of a
  // separate rail/meter bolted on elsewhere.
  const skirt = Math.min(26, Math.max(6, (hiX - loX) * 0.18));
  const bandHot = hot === "band";
  const peakMax = h * 0.6; // leaves headroom so a peak never touches the ribbon's own top edge
  const bumpHalfW = Math.max(1, Math.min(6, (hiX - loX) / 4)); // never let the two peaks collide
  const hpPeak = clamp(hpResFrac, 0, 1) * peakMax;
  const lpPeak = clamp(lpResFrac, 0, 1) * peakMax;
  ctx.beginPath();
  ctx.moveTo(Math.max(0, loX - skirt), h);
  if (hpPeak > 1) {
    ctx.lineTo(Math.max(0, loX - bumpHalfW), 2);
    ctx.lineTo(loX, 2 - hpPeak);
    ctx.lineTo(Math.min(loX + bumpHalfW, hiX), 2);
  } else {
    ctx.lineTo(loX, 2);
  }
  if (lpPeak > 1) {
    ctx.lineTo(Math.max(hiX - bumpHalfW, loX), 2);
    ctx.lineTo(hiX, 2 - lpPeak);
    ctx.lineTo(Math.min(w, hiX + bumpHalfW), 2);
  } else {
    ctx.lineTo(hiX, 2);
  }
  ctx.lineTo(Math.min(w, hiX + skirt), h);
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
    [loX, "hp"],
    [hiX, "lp"],
  ] as [number, RibbonHot][]) {
    const on = hot === id;
    const gx = Math.round(x);
    ctx.fillStyle = accent;
    ctx.globalAlpha = on ? 1 : 0.85;
    ctx.fillRect(gx - 1, 0, 3, h);
    ctx.globalAlpha = on ? 0.9 : 0.55;
    ctx.fillStyle = "#000";
    for (let k = -1; k <= 1; k++) ctx.fillRect(gx, h / 2 + k * 3, 1, 1);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// NO DEAD ZONE — outside the band, the nearer cut jumps to where you pressed. A ribbon that
// ignores you over most of its width reads as broken.
export function hitFreqRibbon(px: number, py: number, rect: RibbonRect, lo: number, hi: number, gripPx: number): RibbonHot {
  if (py < rect.y || py > rect.y + rect.h) return null;
  const x = px - rect.x;
  const loX = fToX(lo, rect.w);
  const hiX = fToX(hi, rect.w);
  if (Math.abs(x - loX) <= gripPx) return "hp";
  if (Math.abs(x - hiX) <= gripPx) return "lp";
  if (x > loX && x < hiX) return "band";
  return x < loX ? "hp" : "lp";
}

export const dragHp = (px: number, rect: RibbonRect, hi: number, range: RibbonRange) => clamp(xToF(px - rect.x, rect.w), range.loMin, Math.min(range.loMax, hi / range.minRatio));
export const dragLp = (px: number, rect: RibbonRect, lo: number, range: RibbonRange) => clamp(xToF(px - rect.x, rect.w), Math.max(range.hiMin, lo * range.minRatio), range.hiMax);

// RESONANCE drag — the grip's OWN vertical axis, live alongside its horizontal (freq) one: grab
// a grip and drag up for more resonance, down for less, exactly like the EQ's own 2D cut-node
// gesture. `dy` is the pointer's vertical movement SINCE LAST CALL (screen Y — up is negative),
// same "delta since last call" convention dragBand already uses below. A fixed pixel sensitivity
// rather than mapping the ribbon's own (short) height 1:1 to the fraction — the ribbon is a thin
// strip, and a control that only had its own ~20px to sweep 0..1 in would be unusably twitchy.
const RES_DRAG_PX = 140; // px of vertical drag to sweep the full 0..1 fraction
export const dragRes = (dy: number, currentFrac: number) => clamp(currentFrac - dy / RES_DRAG_PX, 0, 1);

// The band's BODY drag — sweep both cuts by the same log-distance so the band keeps its width.
// `dx` is the pointer's movement SINCE LAST CALL (not since the gesture started) — the caller
// tracks its own lastX, same as the delay always has. At a rail, this SLIDES the band along it
// rather than freezing: a hard stop reads as "broken", and the whole point of a body-drag is
// that the band's width survives the sweep.
//
// The ratio is FIXED for the sweep (that's what "keeps its width" means), so choosing nLo alone
// determines nHi = nLo·ratio — the only freedom is which nLo values keep BOTH ends inside their
// own bounds: nLo ∈ [loMin, loMax] AND nLo·ratio ∈ [hiMin, hiMax] ⇒ nLo ∈ [max(loMin,hiMin/ratio),
// min(loMax,hiMax/ratio)]. One clamp of that interval, no recompute-and-reclamp dance needed.
export function dragBand(dx: number, rect: RibbonRect, lo: number, hi: number, range: RibbonRange): [number, number] {
  const dLog = (dx / rect.w) * SPAN;
  const ratio = hi / lo;
  const lo2 = Math.max(range.loMin, range.hiMin / ratio);
  const hi2 = Math.min(range.loMax, range.hiMax / ratio);
  const nLo = clamp(lo * Math.exp(dLog), lo2, hi2);
  return [nLo, nLo * ratio];
}

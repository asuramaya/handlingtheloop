// The frequency-band ribbon — a horizontal strip on a log-Hz scale showing a low/high cut
// window as a plateau with sloped shoulders (a response curve, not a progress bar): drag an
// EDGE to move one cut, drag the BODY to sweep both together (the band keeps its width). Built
// for the delay's tap timeline, now shared with the reverb's dome — one control, drawn and hit
// the same way everywhere it appears, instead of two hand-derived copies drifting apart.

export interface RibbonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The cuts may not cross (or meet) — a band that isn't a band is just a mute. Each caller owns
// its own device's real bounds; this primitive only enforces "stay a band" within them.
export interface RibbonRange {
  min: number;
  max: number;
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
// this only translates to rect.x/rect.y and draws within rect.w × rect.h.
export function drawFreqRibbon(ctx: CanvasRenderingContext2D, rect: RibbonRect, lo: number, hi: number, accent: string, hot: RibbonHot) {
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
  // (what gets through?) — which is the actual question.
  const skirt = Math.min(26, Math.max(6, (hiX - loX) * 0.18));
  const bandHot = hot === "band";
  ctx.beginPath();
  ctx.moveTo(Math.max(0, loX - skirt), h);
  ctx.lineTo(loX, 2);
  ctx.lineTo(hiX, 2);
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

export const dragHp = (px: number, rect: RibbonRect, hi: number, range: RibbonRange) => clamp(xToF(px - rect.x, rect.w), range.min, hi / range.minRatio);
export const dragLp = (px: number, rect: RibbonRect, lo: number, range: RibbonRange) => clamp(xToF(px - rect.x, rect.w), lo * range.minRatio, range.max);

// The band's BODY drag — sweep both cuts by the same log-distance so the band keeps its width.
// `dx` is the pointer's movement SINCE LAST CALL (not since the gesture started) — the caller
// tracks its own lastX, same as the delay always has. At a rail, this SLIDES the band along it
// rather than freezing: a hard stop reads as "broken", and the whole point of a body-drag is
// that the band's width survives the sweep.
export function dragBand(dx: number, rect: RibbonRect, lo: number, hi: number, range: RibbonRange): [number, number] {
  const dLog = (dx / rect.w) * SPAN;
  const ratio = hi / lo;
  let nLo = clamp(lo * Math.exp(dLog), range.min, range.max / ratio);
  const nHi = clamp(nLo * ratio, range.min * ratio, range.max);
  nLo = nHi / ratio;
  return [nLo, nHi];
}

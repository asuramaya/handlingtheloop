// The readout — a thin strip across the top of an FX canvas, three fixed zones, always in the
// same place: LEFT = what the device IS, MIDDLE = what you're TOUCHING (blank when you aren't),
// RIGHT = its secondary/tone info. One law for every FX panel's status text, instead of each viz
// hand-rolling its own three-zone contract — which is exactly what Delay and Reverb used to do,
// in parallel, byte-for-byte the same layout maintained twice. Deliberately decoupled from
// FreqRibbon: a filter strip is one possible thing that sits BELOW this row, not a dependency of
// it — CRUSH/GATE/MOD/NOISE/SAT have no ribbon at all and still get the same status row.

export const READOUT_H = 13;

export interface ReadoutSpec {
  left?: string;
  mid?: string;
  midHot?: boolean; // true while mid's value is actively being touched (white vs accent)
  right?: string;
  rightAlpha?: number; // override the default dim (e.g. Reverb's blinking FROZEN)
}

// Trim a " · "-joined string to a pixel budget by dropping its TRAILING segments (the least
// important detail is written last by convention), then, if even the first segment won't fit,
// clip it with an ellipsis. Never lets two zones draw over each other at a narrow width.
const SEP = "  ·  ";
// ★ MEASURING TEXT IS NOT FREE, AND THIS RUNS THREE TIMES A FRAME PER OPEN PANEL. Every FX panel
// draws this strip from its own rAF loop, and every zone calls measureText at least once — more
// when it has to trim, where the fallback shrinks the string ONE CHARACTER AT A TIME, measuring
// each step. Measured with scripts/phonelab/laglab.mjs at 4x CPU with a track loaded and playing,
// drawReadout was 1035 ms of self time over the run, in the same band as the waveform.
//
// The saving grace is that the ANSWER almost never changes: the text is a formatted parameter and
// the width is a panel that is not being resized, so frame N+1 asks the identical question frame N
// already answered. The font is a module constant (set on the ctx below), so it is not part of the
// key — if that ever becomes a variable, it has to be.
//
// Bounded, and bounded by CLEARING rather than by evicting: the keys are value strings, so a knob
// swept across its range mints a new one per distinct value and an LRU would spend more on
// bookkeeping than the measure it saves. Dropping the whole map on overflow costs one cold frame.
const FIT_CACHE = new Map<string, string>();
const FIT_CACHE_MAX = 800;
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return "";
  // Quantise the width: a panel mid-resize produces a fractional pixel every frame, which would
  // make every key unique and the cache pure overhead during the one gesture it most needs to be cheap.
  const key = `${Math.round(maxW)}|${text}`;
  const hit = FIT_CACHE.get(key);
  if (hit !== undefined) return hit;
  const out = fitTextUncached(ctx, text, maxW);
  if (FIT_CACHE.size >= FIT_CACHE_MAX) FIT_CACHE.clear();
  FIT_CACHE.set(key, out);
  return out;
}
// The width of an already-fitted string, cached on the same terms as FIT_CACHE and for the same
// reason: the layout below needs the exact widths of `mid` and `left` every frame, and measureText
// is the expensive call whichever caller makes it. Exact, not approximate — the font is fixed and
// measureText is unaffected by the canvas transform, so the same string always has the same width.
const WIDTH_CACHE = new Map<string, number>();
function widthOf(ctx: CanvasRenderingContext2D, text: string): number {
  const hit = WIDTH_CACHE.get(text);
  if (hit !== undefined) return hit;
  const w = ctx.measureText(text).width;
  if (WIDTH_CACHE.size >= FIT_CACHE_MAX) WIDTH_CACHE.clear();
  WIDTH_CACHE.set(text, w);
  return w;
}
function fitTextUncached(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  const parts = text.split(SEP);
  while (parts.length > 1) {
    parts.pop();
    const t = parts.join(SEP);
    if (ctx.measureText(t).width <= maxW) return t;
  }
  let t = parts[0];
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t.length > 1 ? t + "…" : "";
}

export function drawReadout(ctx: CanvasRenderingContext2D, w: number, accent: string, spec: ReadoutSpec) {
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, w, READOUT_H);
  // Caps-centred, not em-box-centred: "middle" at half-height puts the em box's centre there,
  // and the em box carries descender room the all-caps text never uses — the caps sat ~2 px
  // high. Anchor the baseline so the cap height (~6.5 px at 9 px) sits with equal air above
  // and below inside the strip.
  const ry = Math.round(READOUT_H * 0.77); // baseline: 10 of 13
  ctx.font = "800 9px ui-monospace, monospace";
  ctx.textBaseline = "alphabetic";
  const pad = 5;
  const gap = 8;
  // MIDDLE first — it's what you're touching, it wins the space; LEFT/RIGHT fit into what's left
  // beside it (or beside each other when it's blank), the right zone giving way before the left.
  let midW = 0;
  const mid = spec.mid ? fitText(ctx, spec.mid, w - pad * 2) : "";
  if (mid) midW = widthOf(ctx, mid);
  const sideBudget = mid ? (w - midW) / 2 - gap - pad : w - pad * 2;
  const left = spec.left ? fitText(ctx, spec.left, sideBudget) : "";
  const leftW = left ? widthOf(ctx, left) : 0;
  const right = spec.right ? fitText(ctx, spec.right, mid ? sideBudget : sideBudget - leftW - (left ? gap : 0)) : "";
  if (left) {
    ctx.textAlign = "left";
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.fillText(left, pad, ry);
  }
  if (right) {
    ctx.textAlign = "right";
    ctx.fillStyle = accent;
    ctx.globalAlpha = spec.rightAlpha ?? 0.55;
    ctx.fillText(right, w - pad, ry);
  }
  if (mid) {
    ctx.textAlign = "center";
    ctx.globalAlpha = 1;
    ctx.fillStyle = spec.midHot ? "#fff" : accent;
    ctx.fillText(mid, w / 2, ry);
  }
  ctx.globalAlpha = 1;
}

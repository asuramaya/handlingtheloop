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
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return "";
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
  if (mid) midW = ctx.measureText(mid).width;
  const sideBudget = mid ? (w - midW) / 2 - gap - pad : w - pad * 2;
  const left = spec.left ? fitText(ctx, spec.left, sideBudget) : "";
  const leftW = left ? ctx.measureText(left).width : 0;
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

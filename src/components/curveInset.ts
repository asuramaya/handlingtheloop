// One standardized curve-preview, shared by the FX visualizers (SatViz transfer curve,
// CrushViz filter response). It fills its OWN small canvas — a dedicated panel to the RIGHT
// of the main viz, not an overlay — so both read identically: same frame, axes, line + glow.
// `sample(t)` maps t∈[0,1] (left→right) to a value: bipolar → [-1,1] around the centre line
// (a transfer curve); unipolar → [0,1] up from the baseline (a frequency response).

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Size a canvas's backing store to its CSS box for crisp HiDPI; returns the CSS w/h + ctx.
export function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function drawCurvePanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accent: string,
  sample: (t: number) => number,
  opts?: { bipolar?: boolean },
) {
  ctx.clearRect(0, 0, w, h);
  const pad = 5;
  const x0 = pad;
  const y0 = pad;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  if (iw < 8 || ih < 8) return;

  // axes: crosshair for a bipolar transfer curve, a baseline for a unipolar response.
  ctx.strokeStyle = `color-mix(in srgb, ${accent} 14%, transparent)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (opts?.bipolar) {
    ctx.moveTo(x0, y0 + ih / 2);
    ctx.lineTo(x0 + iw, y0 + ih / 2);
    ctx.moveTo(x0 + iw / 2, y0);
    ctx.lineTo(x0 + iw / 2, y0 + ih);
  } else {
    ctx.moveTo(x0, y0 + ih - 1);
    ctx.lineTo(x0 + iw, y0 + ih - 1);
  }
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 4;
  ctx.beginPath();
  const N = Math.max(2, Math.round(iw));
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const v = sample(t);
    const px = x0 + t * iw;
    const py = opts?.bipolar ? y0 + ih / 2 - v * (ih / 2) * 0.92 : y0 + ih - clamp01(v) * (ih - 1) - 1;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// One standardized curve-preview box, shared by the FX visualizers (SatViz transfer curve,
// CrushViz filter response) so they read identically — same corner, size, frame, axes, glow.
// `sample(t)` maps t∈[0,1] (left→right) to a value: bipolar → [-1,1] around the centre line
// (a transfer curve); unipolar → [0,1] up from the baseline (a frequency response).

export function drawCurveInset(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accent: string,
  sample: (t: number) => number,
  opts?: { bipolar?: boolean },
) {
  const s = Math.min(74, w * 0.3, h * 0.62); // square, bottom-right
  if (s < 24) return; // too small to be legible — skip
  const x = w - s - 6;
  const y = h - s - 6;

  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x, y, s, s);
  ctx.lineWidth = 1;
  ctx.strokeStyle = `color-mix(in srgb, ${accent} 20%, transparent)`;
  ctx.strokeRect(x, y, s, s);

  // axes: crosshair for a bipolar transfer curve, a baseline for a unipolar response.
  ctx.strokeStyle = `color-mix(in srgb, ${accent} 13%, transparent)`;
  ctx.beginPath();
  if (opts?.bipolar) {
    ctx.moveTo(x, y + s / 2);
    ctx.lineTo(x + s, y + s / 2);
    ctx.moveTo(x + s / 2, y);
    ctx.lineTo(x + s / 2, y + s);
  } else {
    ctx.moveTo(x, y + s - 1);
    ctx.lineTo(x + s, y + s - 1);
  }
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 4;
  ctx.beginPath();
  const N = Math.max(2, Math.round(s));
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const v = sample(t);
    const px = x + t * s;
    const py = opts?.bipolar ? y + s / 2 - v * (s / 2) * 0.92 : y + s - Math.max(0, Math.min(1, v)) * (s - 2) - 1;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

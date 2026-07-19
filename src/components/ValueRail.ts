// The value rail — a lane with a thin always-visible track and a puck riding it at the current
// level: BOTTOM 0 → TOP 100, monotonic, absolute (the level IS the value, so the puck never jumps
// on grab). Built for the delay's DRIVE/DUCK gutters, shared with the reverb's control row — one
// law for every vertical magnitude in this app, instead of each panel re-deriving its own
// bipolar-or-not vertical drag by hand.

export interface RailRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function drawRail(ctx: CanvasRenderingContext2D, rect: RailRect, value: number, accent: string, hot: boolean, railW = 3, puckW = 11) {
  const cx = rect.x + rect.w / 2;
  const top = rect.y;
  const bot = rect.y + rect.h;
  const lvl = bot - clamp01(value) * (bot - top);
  ctx.fillStyle = accent;
  ctx.globalAlpha = hot ? 0.22 : 0.12;
  ctx.fillRect(cx - railW / 2, top, railW, bot - top);
  // The puck — the level IS the value, riding the rail. Visible at zero too, or the lane reads as
  // a dead box you have to discover with the mouse.
  const puckH = hot ? 9 : 7;
  const pw = hot ? puckW + 2 : puckW;
  ctx.globalAlpha = hot ? 1 : 0.88;
  ctx.fillRect(cx - pw / 2, clamp(Math.round(lvl - puckH / 2), top, bot - puckH), pw, puckH);
  ctx.globalAlpha = 1;
}

export const hitRail = (px: number, py: number, rect: RailRect) => px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;

// BOTTOM 0 → TOP 100, monotonic, absolute — the level under your finger IS the value. It used to
// be centred (|py − midY|), the same bipolar bug a bare magnitude keeps reinventing: the middle
// meant one thing and both rails meant the same other thing, so nothing said which way was "more".
export const dragRail = (py: number, rect: RailRect) => clamp01((rect.y + rect.h - py) / Math.max(1, rect.h));

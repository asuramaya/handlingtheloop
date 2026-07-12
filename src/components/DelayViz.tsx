import { useEffect, useRef } from "react";

// The Delay's instrument — an echo-tap timeline you PLAY, not a picture of one.
//
// It used to be read-only, which made the panel absurd: a rack of number cells sitting under a
// canvas that already drew every one of those same params. Now the canvas IS the control surface,
// the way the EQ's curve is:
//
//   • GRAB A TAP        → drag sideways = TIME (the tap you're holding follows your cursor, so
//                         grabbing the 3rd echo and pulling right sets time to a third of where
//                         you drop it). With SYNC lit it snaps to the note grid.
//                       → drag up/down = FEEDBACK, solved so THAT tap lands at that height
//                         (fb = amp^(1/n)). The first echo is pinned at unity by the topology —
//                         out = x(t−T) + fb·out(t−T) — so grabbing it is pure TIME. Which is
//                         right: the further out the tap, the more it's about the tail.
//   • THE FILTER RIBBON → the echoes' tone window on a log-freq scale. Drag an EDGE to move one
//                         cut; drag the BODY to sweep the whole band. That body-drag is what the
//                         old LINK chip did, so LINK is deleted, not redesigned — it only ever
//                         existed because HP and LP were two separate cells.
//
// Still drawn, still read-only (they have their own cells): DEPTH/RATE as a live scrolling LFO,
// DUCK as a sidechain dip on the early taps, WIDTH as an L/R split, DRIVE as a warm glow.

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
  drive: number; // analog saturation (0..1)
  duck: number; // sidechain ducking (0..1)
  width: number; // stereo L/R time spread (0..1)
  // TIME left the cell row, so the viz has to SAY it — and it has to say it from the value it just
  // painted, not from a string React hands back a render later (mid-drag that lags a division
  // behind the tap you're holding). So: the grid, and the viz names the note itself.
  snapBeats?: number[]; // the note divisions TIME snaps to (absent when free-running)
  snapLabels?: string[]; // …and their names, index-matched
  onTime: (seconds: number) => void; // the panel snaps to the note grid when synced
  onFeedback: (v: number) => void;
  onFilters: (hp: number, lp: number) => void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const MOD_MAX = 0.012; // matches DELAY modDepth cell max — normalises depth to 0..1
const FB_MAX = 0.95;
const MAX_TIME = 2; // the delay line's ceiling (DelayFx clamps here too)
const HP_MIN = 20;
const LP_MAX = 18000;
const BAND_MIN_RATIO = 1.35; // the cuts may not cross (or meet) — a band needs to stay a band
const GRIP_PX = 10; // how close counts as "on" a filter edge
const TAP_GRIP = 16; // ...and on a tap. Wider: the taps are a 3px bar and sit ~150px apart, so
// there's nothing to hit by accident, and a stingy grip just makes the surface feel dead.
const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);

// log-frequency ↔ x, 20 Hz‥20 kHz across the width
const fToX = (f: number, w: number) => (Math.log(clamp(f, 20, 20000) / 20) / Math.log(1000)) * w;
const xToF = (x: number, w: number) => 20 * Math.exp((clamp(x, 0, w) / w) * Math.log(1000));

type Grab =
  | { kind: "tap"; n: number }
  | { kind: "hp" }
  | { kind: "lp" }
  | { kind: "band"; lastX: number };

export function DelayViz({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, onTime, onFeedback, onFilters }: DelayVizProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab | null>(null);
  const hover = useRef<string>(""); // which handle the cursor is over → cursor shape + highlight
  const kickRef = useRef<() => void>(() => {}); // request one repaint (the loop idles when nothing moves)

  // The draw loop reads props through a ref so the pointer handlers (attached once) and the
  // renderer always agree on the same values.
  const p = useRef({ time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, onTime, onFeedback, onFilters });
  p.current = { time, feedback, mix, pingpong, frozen, bpm, accent, hp, lp, modDepth, modRate, drive, duck, width, snapBeats, snapLabels, onTime, onFeedback, onFilters };

  // Geometry, shared by the renderer and the hit-tests — one source of truth, or the thing you
  // grab won't be the thing you see.
  const geom = (h: number) => {
    const ribbonH = Math.max(20, Math.round(h * 0.2));
    const top = ribbonH + 3;
    const midY = top + (h - top) / 2;
    return { ribbonH, top, midY, maxBar: (h - top) * 0.42 };
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
  // Now: two bars when we know the tempo, else the delay's full range. The taps move; the ruler
  // never does.
  const windowOf = (beat: number) => (beat > 0 ? beat * 8 : MAX_TIME * 1.2);

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

    const start = window.performance.now();

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
      const windowSec = windowOf(beat);
      const xOf = (sec: number) => (sec / windowSec) * w;
      const { ribbonH, top, midY, maxBar } = geom(h);
      const elapsed = (now - start) / 1000;
      const accent = s.accent;

      // === THE FILTER RIBBON — the echoes' tone window, and a control. Edges are grips; the body
      // sweeps the band. ===
      const lo = fToX(s.hp, w);
      const hi = fToX(s.lp, w);
      const rH = ribbonH - 4;
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fillRect(0, 0, w, rH);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = accent;
      ctx.fillRect(lo, 0, Math.max(1, hi - lo), rH);
      ctx.globalAlpha = 1;
      // the two grips
      for (const [x, id] of [
        [lo, "hp"],
        [hi, "lp"],
      ] as [number, string][]) {
        const on = hover.current === id || grab.current?.kind === id;
        ctx.fillStyle = accent;
        ctx.globalAlpha = on ? 1 : 0.8;
        ctx.fillRect(round(x) - (id === "hp" ? 0 : 2), 0, 2, rH);
        ctx.globalAlpha = 1;
      }
      if (hover.current === "band" || grab.current?.kind === "band") {
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.6;
        ctx.strokeRect(round(lo) + 0.5, 0.5, Math.max(1, hi - lo) - 1, rH - 1);
        ctx.globalAlpha = 1;
      }
      // the band's numbers, inside the band when it's wide enough, outside when it isn't
      ctx.font = "700 9px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.85;
      const bandLabel = `${fmtF(s.hp)} — ${fmtF(s.lp)}`;
      const tw = ctx.measureText(bandLabel).width;
      ctx.textAlign = hi - lo > tw + 14 ? "center" : "left";
      ctx.fillText(bandLabel, hi - lo > tw + 14 ? (lo + hi) / 2 : Math.min(hi + 6, w - tw - 4), rH / 2);
      ctx.globalAlpha = 1;

      // beat grid + centre line (in the timeline half only)
      if (beat > 0) {
        ctx.lineWidth = 1;
        for (let sec = beat, k = 1; sec < windowSec; sec += beat, k++) {
          ctx.strokeStyle = k % 4 === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
          const x = Math.round(xOf(sec)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY + 0.5);
      ctx.lineTo(w, midY + 0.5);
      ctx.stroke();

      // === DEPTH/RATE — a live LFO that actually scrolls. Flat (invisible) at depth 0. ===
      const modN = clamp01(s.modDepth / MOD_MAX);
      const phase = 2 * Math.PI * s.modRate * elapsed;
      const lfoNow = modN * Math.sin(-phase);
      if (modN > 0.001 && s.modRate > 0) {
        const lfoAmp = modN * (h - top) * 0.22;
        const cycles = Math.max(0.5, s.modRate * windowSec);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
          const y = midY + lfoAmp * Math.sin((2 * Math.PI * cycles * x) / w - phase);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      // === THE TAPS ===
      const wet = 0.35 + 0.65 * clamp01(s.mix);
      const modShift = lfoNow * 8;
      const widthOff = clamp01(s.width) * 7;
      const duckTau = (beat > 0 ? beat : 0.5) * 0.5;
      const duckGain = (sec: number) => 1 - clamp01(s.duck) * Math.exp(-sec / duckTau);
      const barW = 3;
      const held = g && g.kind === "tap" ? g.n : -1;
      const tap = (x: number, amp: number, side: "up" | "down", alpha: number, lit: boolean) => {
        const bh = Math.max(1, maxBar * amp);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = lit ? "#fff" : accent;
        const bw = lit ? barW + 2 : barW;
        if (side === "up") ctx.fillRect(round(x - bw / 2), round(midY - bh), bw, round(bh));
        else ctx.fillRect(round(x - bw / 2), round(midY), bw, round(bh));
        ctx.globalAlpha = 1;
      };

      // the dry hit at t=0 — the source, not an echo. Never grabbable.
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(1, round(midY - maxBar), barW, round(maxBar * 2));
      ctx.globalAlpha = 1;

      // THE MAGNET, shown only while you're dragging a tap. TIME snaps to note divisions, so the
      // tap jumps from one to the next — and an unexplained jump reads as jitter, as the surface
      // misbehaving. Draw the targets and the same jump reads as magnetism, which is what it is.
      if (g && g.kind === "tap" && beat > 0 && s.snapBeats?.length) {
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 1;
        for (const b of s.snapBeats) {
          const x = Math.round(xOf(b * beat * (g.n + 1))) + 0.5;
          if (x > w) continue;
          ctx.beginPath();
          ctx.moveTo(x, midY - maxBar - 4);
          ctx.lineTo(x, midY + maxBar + 4);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // THE DECAY ENVELOPE — the tail, drawn as a curve through the tap tips. Without it the tail
      // is a row of ever-shorter bars fading to nothing, so "grab the tail and pull it up" means
      // aiming at a 2px stub you can barely see. The curve shows you where the tail IS.
      if (!s.frozen) {
        ctx.beginPath();
        for (let n = 0; n < 64; n++) {
          const ts = (n + 1) * t;
          if (ts > windowSec) break;
          const a = Math.pow(Math.max(0, Math.min(0.999, s.feedback)), n) * duckGain(ts);
          const x = xOf(ts);
          const y = midY - maxBar * a;
          n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.3;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      ctx.shadowColor = "rgba(255,170,90,0.9)";
      ctx.shadowBlur = clamp01(s.drive) * 8;
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        const base = s.frozen ? 1 : Math.pow(Math.max(0, Math.min(0.999, s.feedback)), n);
        if (!s.frozen && base < 0.02) break;
        const amp = base * duckGain(ts);
        const where = s.pingpong ? (n % 2 === 0 ? "up" : "down") : "both";
        const x = xOf(ts) + modShift;
        const a = 0.55 + 0.45 * amp * wet;
        const lit = n === held || hover.current === `tap${n}`;
        if (where === "up" || where === "both") tap(x - (where === "both" ? widthOff : 0), amp, "up", a, lit);
        if (where === "down" || where === "both") tap(x + (where === "both" ? widthOff : 0), amp, "down", a, lit);
      }
      ctx.shadowBlur = 0;

      // TIME and FEEDBACK left the cell row — so the viz has to SAY them. Bottom-left, quiet.
      ctx.font = "800 9.5px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.9;
      // Name the note from the time we just drew — never from a prop that arrives a render late.
      let label = `${Math.round(t * 1000)}ms`;
      if (s.snapBeats?.length && s.snapLabels?.length && beat > 0) {
        const beats = t / beat;
        let bi = 0;
        let bd = Infinity;
        s.snapBeats.forEach((bv, i) => {
          const d = Math.abs(Math.log(bv / Math.max(1e-4, beats)));
          if (d < bd) {
            bd = d;
            bi = i;
          }
        });
        label = s.snapLabels[bi] ?? label;
      }
      ctx.fillText(`${label}  ·  ${Math.round(clamp01(s.feedback) * 100)}%`, 5, h - 3);
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
    const hitAt = (px: number, py: number): { kind: string; n?: number } | null => {
      const w = lastW;
      const h = lastH;
      const s = p.current;
      const { ribbonH, top } = geom(h);
      if (py <= ribbonH) {
        const lo = fToX(s.hp, w);
        const hi = fToX(s.lp, w);
        if (Math.abs(px - lo) <= GRIP_PX) return { kind: "hp" };
        if (Math.abs(px - hi) <= GRIP_PX) return { kind: "lp" };
        if (px > lo && px < hi) return { kind: "band" };
        // NO DEAD ZONE. Outside the band, the nearer cut jumps to where you pressed — the whole
        // ribbon is live. A strip that ignores you over most of its width reads as broken.
        return { kind: px < lo ? "hp" : "lp" };
      }
      if (py < top) return null;
      const t = Math.max(0.001, s.time);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const windowSec = windowOf(beat);
      let best = -1;
      // The grip can never be wider than half the gap to the next tap, or neighbouring grips
      // overlap and you grab the wrong echo. At 1/16 in a two-bar window the taps are ~24px apart.
      let bestD = Math.min(TAP_GRIP, Math.max(4, ((t / windowSec) * w) / 2));
      for (let n = 0; n < 64; n++) {
        const ts = (n + 1) * t;
        if (ts > windowSec) break;
        // Only grab a tap you can SEE. An invisible one (decayed past the draw threshold) offered
        // absurd leverage — fb = amp^(1/n) with a big n turns a 2px nudge into a jump to 95%.
        const base = s.frozen ? 1 : Math.pow(Math.max(0, Math.min(0.999, s.feedback)), n);
        if (!s.frozen && base < 0.02) break;
        const d = Math.abs(px - (ts / windowSec) * w);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best >= 0 ? { kind: "tap", n: best } : null;
    };

    // ★ Paint from what we just computed — never wait for a React round-trip. The handlers push
    // the new value into the device AND into `p.current`, so the very next frame draws the gesture
    // that produced it. Before, the canvas only learned its own values when React re-rendered and
    // reassigned the props mirror: it was always at least a render behind its own input, and any
    // batching or throttling of that render read as a dead surface. (The next real render
    // overwrites the mirror with the device's own values, which agree — so this is a lead, not a
    // lie.)
    const setFilters = (hp: number, lp: number) => {
      p.current.hp = hp;
      p.current.lp = lp;
      p.current.onFilters(hp, lp);
    };
    const setTime = (sec: number) => {
      p.current.time = sec;
      p.current.onTime(sec);
    };
    const setFeedback = (v: number) => {
      p.current.feedback = v;
      p.current.onFeedback(v);
    };

    const apply = (px: number, py: number) => {
      const g = grab.current;
      if (!g) return;
      const w = lastW;
      const h = lastH;
      const s = p.current;
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
      // A TAP: X = time (this tap follows the cursor), Y = feedback (this tap lands at this height).
      const { midY, maxBar } = geom(h);
      const beat = s.bpm ? 60 / s.bpm : 0;
      const secAt = (clamp(px, 1, w) / w) * windowOf(beat);
      setTime(clamp(secAt / (g.n + 1), 0.02, MAX_TIME));
      if (g.n >= 1) {
        const amp = clamp01(Math.abs(py - midY) / Math.max(1, maxBar));
        // amp = fb^n  ⇒  fb = amp^(1/n). Solve for the tap you're actually holding.
        setFeedback(clamp(Math.pow(Math.max(amp, 1e-4), 1 / g.n), 0, FB_MAX));
      }
    };

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { px, py } = local(e);
      const hit = hitAt(px, py);
      if (!hit) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (hit.kind === "tap") grab.current = { kind: "tap", n: hit.n! };
      else if (hit.kind === "band") grab.current = { kind: "band", lastX: px };
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
      const id = !hit ? "" : hit.kind === "tap" ? `tap${hit.n}` : hit.kind;
      if (id !== hover.current) {
        hover.current = id;
        canvas.style.cursor = !hit ? "default" : hit.kind === "band" ? "grab" : hit.kind === "tap" ? "move" : "ew-resize";
        kick();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!grab.current) return;
      grab.current = null;
      canvas.releasePointerCapture?.(e.pointerId);
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

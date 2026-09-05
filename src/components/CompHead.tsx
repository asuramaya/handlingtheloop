import { useEffect, useRef } from "react";
import type { Deck, CompFx } from "@htl/audio";
import { drawReadout, READOUT_H } from "./Readout";
import { drawFreqRibbon, hitFreqRibbon, dragHp, dragLp, dragBand, fmtHz, type RibbonHot, type RibbonRange } from "./FreqRibbon";

// COMP's head — the READOUT and the SC-HP/LP ribbon on ONE full-panel-width canvas, which is
// exactly how DelayViz (DelayViz.tsx:361-376) and ReverbViz (ReverbViz.tsx:229-306) build theirs:
//
//     ribY   = READOUT_H            ← readout occupies the canvas's own top strip
//     ribbonH= narrow ? max(26,.22h) : max(20,.2h)
//     draw   → { x: 0, y: ribY, w, h: ribbonH - 4 }      (the -4 is the ribbon's own footroom)
//     hit    → { x: 0, y: ribY, w, h: ribbonH }          (full height — a fat thumb target)
//
// ★ WHY THIS IS A SEPARATE STRIP AND NOT DRAWN INTO THE CURVE. The ribbon is a FULL-WIDTH ruler:
// its x axis is 20 Hz .. 20 kHz across the panel, the same three decades in the same pixels as
// Delay's and Reverb's. Drawn into CompViz's canvas it inherited that canvas's width instead —
// and CompViz is the MIDDLE column of a three-column row (A/R pad left, MAKEUP/LOOK right), so
// the ruler was ~65% of the panel, inset from both edges, with a different Hz-per-pixel to every
// other ribbon in the rack. Two ribbons only read as the same control if their rulers line up;
// this one couldn't, at any width. Sharing the curve's border bought local seamlessness at the
// cost of the thing that actually makes a shared widget shared. The head strip spans the panel,
// so COMP's 20 Hz, 1 kHz and 20 kHz land on the same x as Reverb's.
//
// The curve gets those ~30px of vertical back, which was the other standing complaint.

interface CompHeadProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
  /** What the operator is touching RIGHT NOW, written by whichever surface owns the gesture —
   *  a ref, not state, because this changes every frame of a drag and only the readout's own
   *  rAF ever reads it. Null = nothing held, and the middle zone goes blank, which is the
   *  contract Readout.ts states outright: "MIDDLE = what you're TOUCHING (blank when you
   *  aren't)". It used to carry the gain-reduction number — live, but not a control's state,
   *  and it sat there permanently, so the one zone reserved for the answer to "what does this
   *  do?" was never free to answer it. GR moved into the plot, where it's a shape and not a
   *  caption (CompViz's drop indicator). */
  hot: { current: string | null };
  setHot: (v: string | null) => void;
}

// The device's own real clamped bounds (CompFx.registerParams) — never a range borrowed from
// another device, or the grip lies about where the value is (see FreqRibbon's own note).
const SC_RANGE: RibbonRange = { loMin: 20, loMax: 500, hiMin: 1000, hiMax: 20000, minRatio: 1.5 };
const NARROW_PX = 260;
const GRIP_PX = 10; // Delay's own grip radius, and Reverb's

// ★ THE HEIGHT IS THE ELEMENT'S, NOT A CONSTANT'S. The ribbon used to be a hardcoded 33px, and
// the reasoning for 33 was sound but time-limited: Delay's ribbon is max(20, .2 × .dly-viz
// height), that canvas measured ~163px in a `--fx-body-h: 192` panel, and 33 is what the formula
// produced THERE. --fx-body-h then became viewport-relative (clamp(148px, 16vh + 16px, 216px)),
// so Delay's ribbon started shrinking with the rack and COMP's did not — the two matched only at
// the top of the range, and everywhere else COMP wore a band a third taller than its sibling's.
// A constant computed from a value that later became variable stops being the same number and
// goes on looking like one.
//
// So .comp-head owns the height in CSS (Delay's own formula, against COMP's canvas budget) and
// this reads the box back. drawFreqRibbon draws its plateau at y=2 and its baseline at y=h, so
// the ribbon rect IS the space under the readout: one authority, nothing to drift.

type Drag = { kind: "hp" | "lp" } | { kind: "band"; lastX: number };

export function CompHead({ deck, slot, accent, set, hot, setHot }: CompHeadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);

  // Same geometry for the draw loop and the hit-tests — one definition, so the picture and the
  // grip can't drift apart.
  const geom = (_w: number, h: number) => {
    // The BOX is the answer, with no second opinion: .comp-head's CSS height already carries the
    // proportion and every floor (including the coarse-pointer one). A `Math.max` here would be a
    // second authority that can only ever disagree by drawing a ribbon taller than the canvas it
    // is drawn into.
    return { ribY: READOUT_H, ribbonH: Math.max(1, h - READOUT_H) };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const dev0 = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!canvas || !dev0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      // Re-fetched every frame, never closed over — the one thing DelayViz does that its siblings
      // don't, and the reason its picture never freezes on a hot-swapped device.
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

      const hp = dev.getParam("scHp");
      const lp = dev.getParam("scLp");
      const isLimit = Math.round(dev.getParam("mode")) === 3;
      drawReadout(ctx, w, accent, {
        // The two headline numbers of the curve — Delay's own "time · feedback" pattern. MODE,
        // AUTO and the SC source are LITERAL BUTTONS in the foot strip, wearing their own state;
        // repeating them here spent the left zone on text that was already on screen twice, and
        // (once it grew to four segments) pushed into the middle zone's space as well.
        left: isLimit ? `CEIL ${dev.getParam("ceiling").toFixed(1)} dB` : `${dev.getParam("threshold").toFixed(1)} dB  ·  ${dev.getParam("ratio").toFixed(1)}:1`,
        mid: hot.current ?? "",
        midHot: hot.current != null,
        // ★ The RIGHT slot is the BAND, in Delay's own words and Delay's own dash — `20 – 6.5k`.
        // drawFreqRibbon deliberately prints no text of its own ("the Hz live in whichever readout
        // owns this control"), so a readout that doesn't say them leaves the numbers nowhere. SC
        // and LOOK join the mode on the LEFT, which is where "what this device IS" already lives.
        right: `${fmtHz(hp > 20 ? hp : 20)} – ${fmtHz(lp)}`,
      });
      const { ribY, ribbonH } = geom(w, h);
      const hotGrip: RibbonHot = drag.current ? drag.current.kind : null;
      drawFreqRibbon(ctx, { x: 0, y: ribY, w, h: ribbonH - 4 }, hp > 20 ? hp : 20, lp, accent, hotGrip);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, slot, accent]);

  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const onDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!canvas || !dev) return;
    const { x, y, w, h } = local(e);
    const { ribY, ribbonH } = geom(w, h);
    const grip = w < NARROW_PX ? GRIP_PX * 1.6 : GRIP_PX;
    const lo = dev.getParam("scHp") > 20 ? dev.getParam("scHp") : 20;
    const kind = hitFreqRibbon(x, y, { x: 0, y: ribY, w, h: ribbonH }, lo, dev.getParam("scLp"), grip);
    if (!kind) return;
    drag.current = kind === "band" ? { kind: "band", lastX: x } : { kind };
    canvas.setPointerCapture(e.pointerId);
    report(dev);
  };

  // What the middle zone says while this ribbon is held or hovered. Held → the live value;
  // hovered → the GESTURE, so you learn what a grip does before committing to dragging it.
  const report = (dev: CompFx) => {
    const d = drag.current;
    const lo = dev.getParam("scHp") > 20 ? dev.getParam("scHp") : 20;
    const hi = dev.getParam("scLp");
    if (!d) return;
    if (d.kind === "hp") setHot(`SC-HP ${fmtHz(lo)}`);
    else if (d.kind === "lp") setHot(`SC-LP ${fmtHz(hi)}`);
    else setHot(`SC BAND ${fmtHz(lo)} – ${fmtHz(hi)}`);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!dev) return;
    if (!d) {
      // hover — name the gesture, not the value
      const { x: hx, y: hy, w: hw, h: hh } = local(e);
      const g = geom(hw, hh);
      const lo = dev.getParam("scHp") > 20 ? dev.getParam("scHp") : 20;
      const k = hitFreqRibbon(hx, hy, { x: 0, y: g.ribY, w: hw, h: g.ribbonH }, lo, dev.getParam("scLp"), hw < NARROW_PX ? GRIP_PX * 1.6 : GRIP_PX);
      setHot(k === "hp" ? "SC-HP  ⇄  drag" : k === "lp" ? "SC-LP  ⇄  drag" : k === "band" ? "SC BAND  ⇄  sweep both" : null);
      return;
    }
    const { x, w, h } = local(e);
    const { ribY, ribbonH } = geom(w, h);
    const rect = { x: 0, y: ribY, w, h: ribbonH };
    const lo = dev.getParam("scHp") > 20 ? dev.getParam("scHp") : 20;
    const hi = dev.getParam("scLp");
    if (d.kind === "hp") set("scHp", dragHp(x, rect, hi, SC_RANGE));
    else if (d.kind === "lp") set("scLp", dragLp(x, rect, lo, SC_RANGE));
    else if (d.kind === "band") {
      const [nLo, nHi] = dragBand(x - d.lastX, rect, lo, hi, SC_RANGE);
      d.lastX = x;
      set("scHp", nLo);
      set("scLp", nHi);
    }
    report(dev);
  };

  const onUp = (e: React.PointerEvent) => {
    drag.current = null;
    setHot(null);
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onDoubleClick = () => {
    set("scHp", 20); // OFF
    set("scLp", 20000); // parked at the top — near-transparent, no 0-sentinel
  };

  return <canvas ref={canvasRef} className="comp-head" onPointerOut={() => !drag.current && setHot(null)} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} onDoubleClick={onDoubleClick} />;
}

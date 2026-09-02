import { useEffect, useRef } from "react";
import type { Deck, CompFx } from "@htl/audio";

// ATTACK/RELEASE — its own small XY pad to the LEFT of the curve, same family as NoiseViz's
// SWEEP/RES pad: X = ATTACK (log), Y = RELEASE (log, bottom-to-top monotonic — up is slower/more,
// the law every fader in the rack uses). A compressor's transfer curve has exactly one axis pair
// (input dB → output dB); ballistics have none of their own, so they get a pad of their own
// rather than crowding into the curve's or living as two more buttonoids beside it.

interface CompArPadProps {
  deck: Deck;
  slot: number;
  accent: string;
  set: (param: string, value: number) => void;
  setHot: (v: string | null) => void; // names the control under the pointer — see CompHead
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const logMap = (frac: number, min: number, max: number) => min * Math.pow(max / min, clamp(frac, 0, 1));
const logFrac = (v: number, min: number, max: number) => Math.log(clamp(v, min, max) / min) / Math.log(max / min);

const ATTACK_MIN = 0.02,
  ATTACK_MAX = 100;
const RELEASE_MIN = 20,
  RELEASE_MAX = 3000;

export function CompArPad({ deck, slot, accent, set, setHot }: CompArPadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // ★ THE LOOP DOES NOT GATE ON THE DEVICE. It used to bail here when the COMP was not resolvable
    // yet — and since none of this effect's deps change when it later appears, the pad would stay
    // blank for the life of the panel. Same family as the worklet-built-too-early bug: something
    // that gives up on a dependency it was merely EARLY for, with nothing to retry it. The device
    // is re-fetched inside draw() every frame anyway, so the loop can simply skip a frame instead.

    let raf = 0;
    const draw = () => {
      // Re-fetched every frame, never captured once — see CompViz's own comment on this.
      const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
      if (!dev) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const attack = dev.getParam("attack");
      const release = dev.getParam("release");
      const hot = dragging.current;

      // crosshair guides to the live point — cheap, and it's what makes an X/Y pad read as two
      // independent axes instead of one dot floating in a box.
      const dx = logFrac(attack, ATTACK_MIN, ATTACK_MAX) * w;
      const dy = (1 - logFrac(release, RELEASE_MIN, RELEASE_MAX)) * h;
      // Half-pixel snap for the 1px guides ONLY (the dot keeps its true position). A 1px stroke
      // centred on an integer coordinate straddles two device pixels and renders as a soft 2px
      // band — which at this size does not read as a thin line, it reads as a smudge.
      const gx = Math.round(dx) + 0.5;
      const gy = Math.round(dy) + 0.5;
      ctx.strokeStyle = `color-mix(in srgb, ${accent} ${hot ? 30 : 16}%, transparent)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(dx, dy, hot ? 4.2 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.shadowColor = accent;
      ctx.shadowBlur = hot ? 8 : 0;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = "rgba(255,255,255,0.3)";
      // Type that scales with the pad. At its old ~40px width everything had to be 7px; now that
      // the phone layout lets it square out to 108px+, fixed 7px would just be small for no reason.
      const axisPx = Math.max(7, Math.min(11, Math.round(w / 13)));
      ctx.font = `${axisPx}px ui-sans-serif, system-ui, sans-serif`;
      // ★ ONE LABEL PER EDGE, EACH ON ITS OWN AXIS. Both used to anchor to the bottom-LEFT corner
      // at fixed 3px/9px offsets — so ATK and the rotated REL sat on top of each other there at
      // every size, which at the old ~40px width read as one smudge of letters. ATK belongs along
      // the bottom (it IS the x axis) and REL up the left (the y axis); centred on their own edges
      // they cannot collide however the pad is sized.
      ctx.textAlign = "center";
      ctx.fillText("ATK", w / 2, h - 3);
      ctx.save();
      ctx.translate(axisPx + 1, h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("REL", 0, 0);
      ctx.restore();

      if (hot) {
        const atkLabel = attack < 1 ? `${(attack * 1000).toFixed(0)}µs` : `${attack.toFixed(1)}ms`;
        const relLabel = release >= 1000 ? `${(release / 1000).toFixed(2)}s` : `${release.toFixed(0)}ms`;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `800 ${Math.max(8, Math.min(13, Math.round(w / 11)))}px ui-monospace, monospace`;
        ctx.textAlign = dx < w / 2 ? "left" : "right";
        ctx.fillText(atkLabel, dx < w / 2 ? Math.min(w - 2, dx + 5) : Math.max(2, dx - 5), dy < h / 2 ? Math.min(h - 4, dy + 20) : Math.max(9, dy - 14));
        ctx.fillText(relLabel, dx < w / 2 ? Math.min(w - 2, dx + 5) : Math.max(2, dx - 5), dy < h / 2 ? Math.min(h - 4, dy + 30) : Math.max(9, dy - 4));
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, slot, accent]);

  const apply = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = 1 - (e.clientY - r.top) / r.height;
    set("attack", logMap(fx, ATTACK_MIN, ATTACK_MAX));
    set("release", logMap(fy, RELEASE_MIN, RELEASE_MAX));
  };
  // The pad's own two-axis gesture, said out loud in the readout's middle zone: the axes while
  // you hover, the values while you drag.
  const report = () => {
    const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!dev) return setHot(null);
    if (!dragging.current) return setHot("ATTACK ⇄   ·   RELEASE ⇅");
    const a = dev.getParam("attack"),
      r = dev.getParam("release");
    setHot(`ATK ${a < 1 ? `${(a * 1000).toFixed(0)}µs` : `${a.toFixed(1)}ms`}  ·  REL ${r >= 1000 ? `${(r / 1000).toFixed(2)}s` : `${r.toFixed(0)}ms`}`);
  };

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    canvasRef.current?.setPointerCapture(e.pointerId);
    apply(e);
    report();
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) apply(e);
    report();
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    setHot(null);
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onDoubleClick = () => {
    set("attack", 10);
    set("release", 250);
  };

  return <canvas ref={canvasRef} className="comp-ar-pad" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} onDoubleClick={onDoubleClick} />;
}

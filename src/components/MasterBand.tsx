import { useEffect, useRef } from "react";
import type { AudioEngine } from "@htl/audio";

// ★ THE MASTER IS A HAIRLINE ACROSS THE WHOLE BOARD, sitting directly above the crossfader inside
// its own row. It costs no line of its own and — crucially — it does not FLANK the fader, so the
// fader keeps its full width and its centre on the deck seam at every screen size.
//
// It is also simply a better master meter than the 130px pill it replaces: a wide, thin level bar
// with the limiter biting in from the right is what a master looks like on real gear, and at board
// width it has the resolution to show a mix breathing rather than a lump moving.
//
// Three signals, deliberately separated so they never fight (the direct-manipulation rule):
//   • the FILL from the left  — live output level
//   • a TICK                  — the volume you set
//   • a RED BITE from the right — gain reduction, the ceiling working
// Level and GR are written straight to the DOM on one rAF; only the tick goes through React, and
// only when you move it.
//
// ★ IT DOES NOT JUMP TO WHERE YOU CLICKED. Every other fader here is an <input type=range>, which
// means a click on the track teleports the value — fine for a crossfader, unacceptable for the
// MASTER, where a stray click near the left end silences the room mid-set. So this is a RELATIVE
// drag: the value moves by how far you moved, from wherever it was. A click that does not move does
// nothing at all.
const FLOOR_DB = -60;
const DECAY = 1.1; // per-frame fall (instant attack, slow decay — VU ballistics)
const GR_FULL_DB = 12;

export function MasterBand({ engine, value, onChange, disabled }: { engine: AudioEngine; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const lvlRef = useRef<HTMLSpanElement>(null);
  const grRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; v: number; w: number } | null>(null);
  const live = useRef({ value, onChange, disabled });
  live.current = { value, onChange, disabled };
  const nudge = (d: number) => {
    const L = live.current;
    if (L.disabled) return;
    L.onChange(Math.max(0, Math.min(1, L.value + d)));
  };

  useEffect(() => {
    let raf = 0;
    let peak = -100;
    const tick = () => {
      const db = engine.masterLevelDb();
      peak = db >= peak ? db : peak - DECAY;
      const lvl = Math.max(0, Math.min(1, (peak - FLOOR_DB) / -FLOOR_DB));
      if (lvlRef.current) lvlRef.current.style.width = `${(lvl * 100).toFixed(1)}%`;
      const gr = Math.max(0, Math.min(1, engine.masterGr / GR_FULL_DB));
      if (grRef.current) grRef.current.style.width = `${(gr * 100).toFixed(1)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // ★ PARITY WITH EVERY OTHER FADER HERE. As the SMART chip the master was a ValueCell, which
  // carries a wheel handler and a right-click reset; as a hand-rolled band it had neither. A
  // desktop DJ scrolls over a control — losing that was a regression, not a design choice.
  // Non-passive, because a wheel over a fader must not also scroll the page behind it.
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (live.current.disabled) return;
      e.preventDefault();
      nudge(e.deltaY < 0 ? 0.02 : -0.02);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      e.preventDefault();
      const next = Math.max(0, Math.min(1, d.v + (e.clientX - d.x) / d.w));
      live.current.onChange(next);
    };
    const up = () => { drag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const pct = `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
  return (
    <div
      ref={boxRef}
      className={`mband ${disabled ? "disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Master output level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      title={`Master ${Math.round(value * 100)} — drag to set, double-click for unity. Red from the right is the limiter working.`}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        const w = boxRef.current?.getBoundingClientRect().width ?? 1;
        // A full board-width throw would make the master hair-trigger, so the drag is geared to a
        // fraction of it: the whole range is a comfortable arm's move, not a twitch.
        drag.current = { x: e.clientX, v: value, w: Math.max(120, w * 0.5) };
      }}
      onDoubleClick={() => { if (!disabled) onChange(1); }}
      // Right-click resets to unity, as it does on every ValueCell on this board.
      onContextMenu={(e) => { e.preventDefault(); if (!disabled) onChange(1); }}
      onKeyDown={(e) => {
        if (disabled) return;
        const step = e.shiftKey ? 0.01 : 0.05;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange(Math.max(0, value - step)); }
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange(Math.min(1, value + step)); }
      }}
    >
      <span className="mband-paint">
        <span ref={lvlRef} className="mband-lvl" />
        <span ref={grRef} className="mband-gr" />
        <span className="mband-tick" style={{ left: pct }} />
      </span>
    </div>
  );
}

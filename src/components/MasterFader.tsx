import { useEffect, useRef } from "react";
import type { AudioEngine } from "@htl/audio";

// ★ ONE OBJECT, THREE ANSWERS. "How loud is it", "how loud do I want it" and "is the ceiling
// fighting me" are one question about the output, and they used to be three things: a MASTER knob
// cell, a separate GR meter, and no master level meter at all. This is the master fader, drawn ON
// its own level meter, with the limiter's gain reduction eating in from the right.
//
// The meter and the GR are written straight to the DOM on one rAF — a meter that re-rendered the
// board sixty times a second would be the WaveformViewport lesson, learned again the hard way.
// Only the fader's value goes through React, and only when you move it.
const FLOOR_DB = -60; // dBFS window the meter spans
const DECAY = 1.1; // per-frame fall (instant attack, slow decay — VU ballistics)
const GR_FULL_DB = 12; // gain reduction that fills the whole bar

export function MasterFader({ engine, value, onChange, disabled }: { engine: AudioEngine; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const lvlRef = useRef<HTMLSpanElement>(null);
  const grRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let peak = -100;
    const tick = () => {
      const db = engine.masterLevelDb();
      peak = db >= peak ? db : peak - DECAY;
      const lvl = Math.max(0, Math.min(1, (peak - FLOOR_DB) / -FLOOR_DB));
      if (lvlRef.current) lvlRef.current.style.width = `${(lvl * 100).toFixed(1)}%`;
      // GR grows from the RIGHT — the same right-to-left convention COMP's own GR meter uses, and
      // the one place on the board where red means "the limiter is working", not "something broke".
      const gr = Math.max(0, Math.min(1, engine.masterGr / GR_FULL_DB));
      if (grRef.current) grRef.current.style.width = `${(gr * 100).toFixed(1)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const frac = Math.max(0, Math.min(1, value));
  return (
    <div className={`mfader ${disabled ? "disabled" : ""}`}>
      <div className="mfader-track">
        <span ref={lvlRef} className="mfader-lvl" />
        <span ref={grRef} className="mfader-gr" />
        <input
          type="range"
          className="mfader-input"
          min={0}
          max={1}
          step={0.01}
          value={value}
          disabled={disabled}
          title="Master output — drag to set, double-click for unity. The bar is the live level; red from the right is the limiter working."
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(1)}
          onContextMenu={(e) => { e.preventDefault(); onChange(1); }}
        />
        {/* The pill IS the handle, as it is on every other fader here. */}
        <div className="lfader-val mfader-val" style={{ left: `calc(${frac} * (100% - 34px) + 17px)` }}>
          <span>{Math.round(value * 100)}</span>
        </div>
      </div>
      <span className="mfader-cap">MST</span>
    </div>
  );
}

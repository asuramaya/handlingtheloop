import { useEffect, useRef } from "react";

// A generic imperative meter: a horizontal fill track + numeric readout, polled on its own rAF
// (never React state — a meter moving at 60 Hz must never re-render the panel it lives in, the
// same WaveformViewport/CompPanel lesson). Originally COMP-specific (gain reduction); now shared
// by anything that needs "a live number, as a bar" — Saturator's output level, the master
// limiter's GR. `rtl` reproduces COMP's own convention (a GR meter reads right-to-left, growing
// leftward as it clamps down, so "nothing happening" is an empty meter).
interface MeterBarProps {
  getValue: () => number; // raw measurement, whatever unit `format`/`toPercent` expect
  toPercent: (v: number) => number; // raw value → 0..100 fill width (caller clamps its own scale)
  format: (v: number) => string;
  unit: string;
  label?: string;
  rtl?: boolean;
  className?: string;
}

export function MeterBar({ getValue, toPercent, format, unit, label, rtl, className }: MeterBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = getValue();
      const pct = Math.max(0, Math.min(100, toPercent(v)));
      if (barRef.current) barRef.current.style.width = `${pct}%`;
      if (readRef.current) readRef.current.textContent = format(v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getValue, toPercent, format]);

  return (
    <div className={`meter-bar ${className ?? ""}`} title={label}>
      <div className={`meter-bar-track ${rtl ? "rtl" : ""}`}>
        <div ref={barRef} className="meter-bar-fill" />
      </div>
      <span ref={readRef} className="meter-bar-read">
        0.0
      </span>
      <span className="meter-bar-unit">{unit}</span>
    </div>
  );
}

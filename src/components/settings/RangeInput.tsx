// THE settings slider: one look everywhere (operator, 2026-11-04: Turntable's sliders "need work to
// look more standardized and clean"). The browser's own range was a bright white track with an
// accent-coloured fill that only some engines drew, and a large native thumb, beside custom
// toggles and segmented buttons that look like nothing native. This draws its own thin track
// with the filled part in the accent (settings.css `.settings-slider`, which reads `--pct`).
import type { CSSProperties } from "react";

export function RangeInput({
  value,
  min,
  max,
  step,
  onChange,
  label,
  className = "",
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
  className?: string;
}) {
  const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <input
      type="range"
      className={`settings-slider ${className}`.trim()}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ["--pct" as string]: `${pct}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

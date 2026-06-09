import { useEffect, useRef, useState } from "react";

interface KnobProps {
  label: string;
  value: number; // initial value (the knob is self-stateful after mount)
  min: number;
  max: number;
  defaultValue: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}

// 0 = pointing up; sweeps ±135° over the value range (270° of travel).
const SWEEP = 135;
const R = 13;
const CX = 16;
const CY = 16;

function polar(deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}
// Arc path from a0 to a1 (degrees, 0 = top, clockwise).
function arc(a0: number, a1: number) {
  const [x0, y0] = polar(a0);
  const [x1, y1] = polar(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// Vertical-drag rotary knob with an accent value-arc and a rotating pointer.
// Drag up to increase / down to decrease; double-click resets to default.
export function Knob({ label, value, min, max, defaultValue, onChange, format }: KnobProps) {
  const [val, setVal] = useState(value);
  const drag = useRef<{ startY: number; startVal: number } | null>(null);
  const lastTap = useRef(0);

  // Follow the prop if a parent ever drives the value (e.g. reset from settings).
  useEffect(() => setVal(value), [value]);

  const set = (next: number) => {
    const v = Math.max(min, Math.min(max, next));
    setVal(v);
    onChange(v);
  };

  // Centre-detent: the default value sits at 12 o'clock and the pointer / fill
  // swing ± from there (each side scaled to its own travel, so asymmetric ranges
  // like the EQ's −26…+6 dB still centre 0 dB at the top).
  const frac =
    val >= defaultValue
      ? (val - defaultValue) / (max - defaultValue || 1)
      : (val - defaultValue) / (defaultValue - min || 1);
  const angle = Math.max(-SWEEP, Math.min(SWEEP, frac * SWEEP));
  const fillPath = angle >= 0 ? arc(0, angle) : arc(angle, 0);

  return (
    <div className="knob">
      <div
        className="knob-dial"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          // Double-tap (touch) / double-click resets to default.
          if (e.timeStamp - lastTap.current < 320) {
            set(defaultValue);
            lastTap.current = 0;
            drag.current = null;
            return;
          }
          lastTap.current = e.timeStamp;
          drag.current = { startY: e.clientY, startVal: val };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          // Drag in ANGLE space (centre-detent), so the pointer turns evenly even
          // when the range is lopsided (EQ −26…+6): a small turn from 12 o'clock
          // boosts a little or cuts a little, like a real mixer.
          const dy = drag.current.startY - e.clientY;
          const sv = drag.current.startVal;
          const startFrac = sv >= defaultValue ? (sv - defaultValue) / (max - defaultValue || 1) : (sv - defaultValue) / (defaultValue - min || 1);
          const f = Math.max(-1, Math.min(1, startFrac + dy / 150));
          set(f >= 0 ? defaultValue + f * (max - defaultValue) : defaultValue + f * (defaultValue - min));
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={() => set(defaultValue)}
        onContextMenu={(e) => {
          e.preventDefault();
          set(defaultValue);
        }}
        style={{ touchAction: "none" }}
      >
        <svg className="knob-ring" viewBox="0 0 32 32" aria-hidden>
          <path className="knob-ring-track" d={arc(-SWEEP, SWEEP)} />
          <path className="knob-ring-fill" d={fillPath} style={{ stroke: "var(--accent)" }} />
        </svg>
        <div className="knob-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      <span className="knob-label">{label}</span>
      <span className="knob-value">{format ? format(val) : val.toFixed(0)}</span>
    </div>
  );
}

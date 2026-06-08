import { useCallback, useRef } from "react";

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}

// Vertical-drag rotary knob. Drag up to increase, down to decrease.
// Double-click resets to the default (the classic "center detent").
export function Knob({
  label,
  value,
  min,
  max,
  defaultValue,
  onChange,
  format,
}: KnobProps) {
  const drag = useRef<{ startY: number; startVal: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startVal: value };
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const dy = drag.current.startY - e.clientY;
      const range = max - min;
      const next = drag.current.startVal + (dy / 150) * range;
      onChange(Math.max(min, Math.min(max, next)));
    },
    [min, max, onChange],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const angle = -135 + ((value - min) / (max - min)) * 270;

  return (
    <div className="knob">
      <div
        className="knob-dial"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => onChange(defaultValue)}
        style={{ touchAction: "none" }}
      >
        <div
          className="knob-pointer"
          style={{ transform: `rotate(${angle}deg)` }}
        />
      </div>
      <span className="knob-label">{label}</span>
      <span className="knob-value">{format ? format(value) : value.toFixed(0)}</span>
    </div>
  );
}

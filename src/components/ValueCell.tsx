import { useEffect, useRef, type ReactNode } from "react";
import { KnobBorder } from "./KnobBorder";

interface ValueCellProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  // Bipolar centre: dbl-click/right-click reset land here. Omit for a unipolar
  // control (reset goes to `reset` ?? min).
  pivot?: number;
  reset?: number; // dbl-click target for a unipolar cell (default: min)
  onChange: (v: number) => void;
  format?: (v: number) => string;
  className?: string;
  disabled?: boolean;
  children?: ReactNode; // overlay slot
  onTap?: () => void; // a clean tap (no drag) fires this — e.g. a stem mute toggle
  kbd?: string; // keyboard hint shown bottom-right (when show-keys is on)
  active?: boolean; // false dims the cell as "off" (e.g. a muted stem)
}

// Pixels of vertical drag that span the WHOLE range. Lower = more sensitive.
const DRAG_SPAN_PX = 180;
// Movement under this (px) counts as a tap (select only), not a drag (adjust).
const TAP_SLOP = 4;

// A number cell that reads like a KNOB: the cell border carries a level indicator
// (an accent trace from min up-and-around to the current value) capped by a little
// circle marker. Tapping SELECTS it (a ring, no value jump). Adjust by relative
// vertical drag or scroll wheel; double-click / right-click resets. (Arrow keys
// are intentionally NOT bound — they belong to the global deck keymap.)
export function ValueCell({ label, value, min, max, step = 0.01, pivot, reset, onChange, format, className, disabled, children, onTap, kbd, active }: ValueCellProps) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startVal: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const bipolar = pivot != null;
  const resetTo = bipolar ? (pivot as number) : reset ?? min;

  const span = max - min || 1;
  const clampStep = (v: number) => {
    const c = Math.max(min, Math.min(max, v));
    return step ? Math.round(c / step) * step : c;
  };

  // Latest props for the native (non-passive) wheel listener, attached once.
  const latest = useRef({ value, min, max, step, onChange, disabled });
  latest.current = { value, min, max, step, onChange, disabled };
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const L = latest.current;
      if (L.disabled) return;
      e.preventDefault();
      // One notch = 1/40 of the range, but never less than a whole step — so a
      // stepped knob (e.g. KEY, ±1 semitone) still moves on every notch.
      const unit = Math.max((L.max - L.min) / 40, L.step || 0);
      const next = L.value + (e.deltaY < 0 ? unit : -unit);
      const c = Math.max(L.min, Math.min(L.max, next));
      L.onChange(L.step ? Math.round(c / L.step) * L.step : c);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={el}
      tabIndex={disabled ? -1 : 0}
      className={`vcell ${className ?? ""} ${bipolar ? "bipolar" : ""} ${disabled ? "disabled" : ""} ${active === false ? "muted" : ""}`}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        if (disabled) return;
        // Right / middle button: let onContextMenu reset the value — don't start a
        // tap/drag (which would fire onTap, e.g. toggle a stem mute).
        if (e.button !== 0) return;
        el.current?.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        // Double-tap / double-click resets.
        if (e.timeStamp - lastTap.current < 320) {
          onChange(resetTo);
          lastTap.current = 0;
          drag.current = null;
          return;
        }
        lastTap.current = e.timeStamp;
        drag.current = { startY: e.clientY, startVal: value, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = d.startY - e.clientY; // up = increase
        if (!d.moved && Math.abs(dy) < TAP_SLOP) return; // still a tap
        d.moved = true;
        onChange(clampStep(d.startVal + (dy / DRAG_SPAN_PX) * span));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        // A clean tap (pointer never moved past the slop) fires onTap — e.g. mute.
        if (d && !d.moved && onTap && !disabled) onTap();
      }}
      onContextMenu={(e) => { e.preventDefault(); if (!disabled) onChange(resetTo); }}
    >
      <KnobBorder value={value} min={min} max={max} pivot={pivot} />
      {children}
      <span className="vcell-label">{label}</span>
      {format && <span className="vcell-value">{format(value)}</span>}
      {kbd && <span className="kbd">{kbd}</span>}
    </div>
  );
}

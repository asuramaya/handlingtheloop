import { useRef } from "react";

interface FaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  className?: string;
}

// Vertical hardware-style fader with a glowing cap and an accent fill that acts
// as the level indicator. Bipolar faders (min < 0, e.g. TEMPO) fill from the
// centre detent; unipolar faders (LEVEL) fill from the bottom. Pointer-drag the
// whole track for fine control; double-click resets to centre / bottom.
export function Fader({ label, value, min, max, step = 0.01, onChange, format, className }: FaderProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastTap = useRef(0);
  const bipolar = min < 0;

  const clampStep = (v: number) => {
    const c = Math.max(min, Math.min(max, v));
    return step ? Math.round(c / step) * step : c;
  };

  const fromY = (clientY: number) => {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = 1 - (clientY - r.top) / r.height; // 0 bottom … 1 top
    onChange(clampStep(min + Math.max(0, Math.min(1, frac)) * (max - min)));
  };

  const frac = (value - min) / (max - min || 1);
  const pct = `${frac * 100}%`;
  // Fill spans bottom→thumb (unipolar) or centre↔thumb (bipolar).
  const fill = bipolar
    ? { bottom: `${Math.min(frac, 0.5) * 100}%`, height: `${Math.abs(frac - 0.5) * 100}%` }
    : { bottom: "0%", height: pct };

  return (
    <div className={`fader ${className ?? ""}`}>
      <div
        ref={track}
        className={`fader-track ${bipolar ? "bipolar" : ""}`}
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          // Double-tap (touch) / double-click resets to default.
          if (e.timeStamp - lastTap.current < 320) {
            onChange(bipolar ? 0 : min);
            lastTap.current = 0;
            dragging.current = false;
            return;
          }
          lastTap.current = e.timeStamp;
          dragging.current = true;
          fromY(e.clientY);
        }}
        onPointerMove={(e) => dragging.current && fromY(e.clientY)}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={() => onChange(bipolar ? 0 : min)}
        onContextMenu={(e) => {
          e.preventDefault();
          onChange(bipolar ? 0 : min);
        }}
      >
        {bipolar && <span className="fader-detent" />}
        <span className="fader-fill" style={{ ...fill, background: "var(--accent)" }} />
        <span className="fader-thumb" style={{ bottom: pct }} />
      </div>
      {label && <span className="fader-label">{label}</span>}
      {format && <span className="fader-value">{format(value)}</span>}
    </div>
  );
}

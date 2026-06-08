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

// Vertical hardware-style fader (channel level / tempo). The DDJ look comes from
// the CSS (.fader track + thumb cap).
export function Fader({ label, value, min, max, step = 0.01, onChange, format, className }: FaderProps) {
  return (
    <div className={`fader ${className ?? ""}`}>
      <input
        className="fader-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ touchAction: "none" }}
      />
      <span className="fader-label">{label}</span>
      {format && <span className="fader-value">{format(value)}</span>}
    </div>
  );
}

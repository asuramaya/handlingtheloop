// A labelled range row used across the settings tabs (Controls, Audio). Shared so the
// tab components can each import it instead of re-declaring it in SettingsPanel.
export function Slider({
  label,
  hint,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  title,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string; // hover tooltip — which gesture/button this actually drives
}) {
  return (
    <div className="settings-row slider-row" title={title}>
      <span className="settings-label">
        {label} <span className="slider-hint">{hint}</span>
      </span>
      <input
        type="range"
        className="settings-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

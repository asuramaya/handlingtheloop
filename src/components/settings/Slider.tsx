import { InfoDot } from "./InfoDot";

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
  info,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string; // legacy hover tooltip; prefer `info`
  // What this slider does, shown behind the row's ⓘ. This REPLACES `title` rather than
  // supplementing it: back-filling `title` from `info` meant hovering the row rendered the
  // bubble AND an unstyled OS tooltip carrying the identical sentence, on top of each other.
  // A native tooltip is also mouse-only, so it was never the accessible half of that pair.
  info?: string;
}) {
  return (
    <div className="settings-row slider-row" title={info ? undefined : title}>
      <span className="settings-label">
        {label}
        {info ? <InfoDot text={info} label={label} /> : null}
      </span>
      {/* The hint is this control's VALUE ("balanced", "4px", "105%"), so it belongs in the
          shared value slot immediately left of the control — not trailing the label, where
          it moved the label's right edge every time the number changed width and stopped
          slider rows lining up with toggle rows. */}
      <span className="settings-control">
        <span className="settings-value">{hint}</span>
        <input
          type="range"
          className="settings-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </span>
    </div>
  );
}

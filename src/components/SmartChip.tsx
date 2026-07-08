import { ValueCell } from "./ValueCell";

interface SmartChipProps {
  smart?: boolean; // Smart Fader armed → the crossfader throw scrubs an auto-transition
  enabled?: boolean; // crossfader live? (disabled = the bar is ignored — Shift+T / FLX shifted state)
  canControl?: boolean; // may this user toggle? (false = non-controller in a session → cell inert)
  shift?: boolean; // board shift held/latched → the cell previews & fires its ALT action (every shifted button does)
  kbd?: string; // keyboard hint for the Smart Fader toggle (shown inside the cell when show-keys is on)
  accentA?: string; // deck A accent → left of the armed A↔B gradient (the cell lives off the crossfader, so it can't inherit --xa/--xb)
  accentB?: string; // deck B accent → right of the armed gradient
  master?: number; // master output volume 0..1 — the buttonoid's knob VALUE (unity = 1)
  onToggleSmart?: () => void; // tap → arm/disarm (mirrors the `T` key)
  onToggleEnabled?: () => void; // hold / right-click / SHIFT-tap → enable/disable the crossfader (mirrors `Shift+T`)
  onMaster?: (v: number) => void; // drag / scroll / FLX MASTER knob → master output volume
}

// SMART buttonoid — the crossfader's two toggles fused onto a master-volume knob, sitting in the I/O
// strip between the mic + capture zones (matching the MIC / DUCK cells). Just like the PLAY cell is
// tap-play + drag-trim, this is: TAP = arm/disarm Smart Fader; DRAG / SCROLL / FLX MASTER knob =
// master output volume; HOLD / RIGHT-CLICK / SHIFT-TAP = enable/disable the whole crossfader;
// DOUBLE-TAP = master back to unity. Board shift flips the tap to the enable/disable alt action and
// relabels, exactly like every other shifted control. The armed A↔B ring rides on top of the knob.
export function SmartChip({ smart, enabled = true, canControl = true, shift = false, kbd, accentA, accentB, master = 1, onToggleSmart, onToggleEnabled, onMaster }: SmartChipProps) {
  return (
    <ValueCell
      className={`smp-io-cell smart-chip ${smart ? "armed" : ""} ${enabled ? "" : "off"} ${shift ? "shifted" : ""}`}
      style={{ ["--xa" as string]: accentA, ["--xb" as string]: accentB }}
      label={shift ? (enabled ? "DISABLE" : "ENABLE") : "SMART"}
      value={master}
      min={0}
      max={1}
      step={0.01}
      reset={1} // double-tap → master back to unity
      disabled={!canControl}
      kbd={kbd}
      format={(v) => `${Math.round(v * 100)}`}
      onChange={(v) => onMaster?.(v)}
      onTap={() => (shift ? onToggleEnabled?.() : onToggleSmart?.())}
      onContextMenu={() => { if (canControl) onToggleEnabled?.(); }}
    />
  );
}

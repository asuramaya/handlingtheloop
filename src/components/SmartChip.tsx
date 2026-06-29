import { useLongPress } from "./useLongPress";

interface SmartChipProps {
  smart?: boolean; // Smart Fader armed → the crossfader throw scrubs an auto-transition
  enabled?: boolean; // crossfader live? (disabled = the bar is ignored — Shift+T / FLX shifted state)
  canControl?: boolean; // may this user toggle? (false = non-controller in a session → chip inert)
  shift?: boolean; // board shift held/latched → the chip previews & fires its ALT action (every shifted button does)
  kbd?: string; // keyboard hint for the Smart Fader toggle (shown inside the chip when show-keys is on)
  accentA?: string; // deck A accent → left of the armed A↔B gradient (the chip lives off the crossfader, so it can't inherit --xa/--xb)
  accentB?: string; // deck B accent → right of the armed gradient
  onToggleSmart?: () => void; // tap → arm/disarm (mirrors the `T` key)
  onToggleEnabled?: () => void; // hold / right-click / SHIFT-tap → enable/disable (mirrors `Shift+T`)
}

// SMART chip — the on-screen / touch home for the crossfader's two toggles, stranded before behind
// the keyboard (T / Shift+T) and the FLX SMART FADER button. Lives in the I/O strip (between the mic
// and capture zones). TAP = arm/disarm Smart Fader; HOLD / RIGHT-CLICK / SHIFT-TAP = enable or
// disable the whole crossfader. With board shift held or latched it FLIPS to its alt action (label +
// click), exactly like every other shifted button; hold + right-click stay the no-keyboard path.
export function SmartChip({ smart, enabled = true, canControl = true, shift = false, kbd, accentA, accentB, onToggleSmart, onToggleEnabled }: SmartChipProps) {
  // Touch parity: a long-press = the right-click alt action (enable/disable), so the toggle is
  // reachable on a touchscreen with no keyboard. Mouse keeps its real right-click via onContextMenu.
  const long = useLongPress<void>(() => { if (canControl) onToggleEnabled?.(); });
  return (
    <button
      type="button"
      className={`smp-io-btn smart-chip ${smart ? "armed" : ""} ${enabled ? "" : "off"} ${shift ? "shifted" : ""}`}
      style={{ ["--xa" as string]: accentA, ["--xb" as string]: accentB }}
      disabled={!canControl}
      title={
        shift
          ? enabled
            ? "Disable the crossfader (shifted)"
            : "Enable the crossfader (shifted)"
          : enabled === false
            ? "Crossfader OFF — shift-tap / hold / right-click to re-enable"
            : smart
              ? "Smart Fader armed — throw the fader to auto-transition · tap to disarm · shift-tap / hold to disable the crossfader"
              : "Tap: arm Smart Fader (auto-transition) · Shift-tap / hold / right-click: disable the crossfader"
      }
      onClick={() => {
        if (long.fired.current) { long.fired.current = false; return; } // swallow the tap a long-press already handled
        if (!canControl) return;
        if (shift) onToggleEnabled?.(); // board shift → fire the alt action, same as Shift+T
        else onToggleSmart?.();
      }}
      onContextMenu={(e) => { e.preventDefault(); if (canControl) onToggleEnabled?.(); }}
      {...long.bind(undefined)}
    >
      <span className="smart-chip-lbl">{shift ? (enabled ? "DISABLE" : "ENABLE") : "SMART"}</span>
      {kbd && <span className="kbd" aria-hidden="true">{kbd}</span>}
    </button>
  );
}

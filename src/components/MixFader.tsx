import { useEffect, useRef } from "react";

// The universal wet/dry — the one control EVERY device has, given one permanent home at the
// foot of the panel instead of hiding as cell 6-of-12 in a different place on every effect.
//
// It's a FADER, not a number cell, because that's what a wet/dry IS: a sweep, not a setting.
// So unlike ValueCell (relative vertical drag — precise, never jumps), this is ABSOLUTE and
// horizontal: press anywhere and the value goes THERE. A DJ throwing the blend to 0 or 100
// mid-phrase wants to slam it, not walk it. Double-click/right-click resets to the DEVICE's
// own neutral (the delay rests at 28% wet, the saturator at 100% — see FxDevice.paramDefault).
//
// It is also the on-screen twin of the FLX BEAT FX DEPTH knob, which drives this exact param.

interface MixFaderProps {
  value: number; // 0..1
  reset: number; // the device's own default (paramDefault("mix"))
  onChange: (v: number) => void;
  disabled?: boolean; // device bypassed — still draggable, just drawn as inert
}

export function MixFader({ value, reset, onChange, disabled }: MixFaderProps) {
  const el = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastTap = useRef(0);

  const at = (clientX: number) => {
    const r = el.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return value;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  // Wheel needs a non-passive native listener to preventDefault (stop the page scrolling
  // under the cursor). Latest props via a ref so it can be attached once.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const L = latest.current;
      L.onChange(Math.max(0, Math.min(1, L.value + (e.deltaY < 0 ? 0.02 : -0.02))));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);

  return (
    <div
      ref={el}
      className={`fx-mix ${disabled ? "off" : ""}`}
      role="slider"
      aria-label="Wet/dry mix"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      tabIndex={0}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Double-click/tap → the device's neutral. Checked BEFORE the jump so a quick
        // double never lands the fader wherever the second press happened to be.
        if (e.timeStamp - lastTap.current < 320) {
          lastTap.current = 0;
          dragging.current = false;
          onChange(reset);
          return;
        }
        lastTap.current = e.timeStamp;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        onChange(at(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(at(e.clientX));
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onChange(reset);
      }}
    >
      {/* No "MIX" caption: the bar is the only fader in the foot and the number is the value.
          A label would just cost width the fill wants — and at a narrow deck width, width is
          the scarce thing. */}
      <div className="fx-mix-fill" style={{ width: `${pct}%` }} />
      <span className="fx-mix-val">{pct}</span>
    </div>
  );
}

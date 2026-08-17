import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { scrollRowOf, wheelScrollRow } from "./hscrollRows";
import { KnobBorder } from "./KnobBorder";
import { usePulse } from "./usePulse";

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
  style?: CSSProperties; // extra inline style (merged after touch-action) — e.g. accent CSS vars
  onTap?: () => void; // a clean tap (no drag) fires this — e.g. a stem mute toggle
  kbd?: string; // keyboard hint shown bottom-right (when show-keys is on)
  active?: boolean; // false dims the cell as "off" (e.g. a muted stem)
  // Right-click / long-press handler. When set, it REPLACES the default reset-on-right-click (e.g.
  // a buttonoid that holds a mode picker — MIC right-click → destination menu). Double-click still resets.
  onContextMenu?: (e: ReactMouseEvent) => void;
}

// Pixels of vertical drag that span the WHOLE range. Lower = more sensitive.
const DRAG_SPAN_PX = 180;
// Movement under this (px) counts as a tap (select only), not a drag (adjust).
const TAP_SLOP = 4;

// A number cell that reads like a KNOB: the cell border carries a level indicator
// (an accent trace from min up-and-around to the current value) capped by a little
// circle marker. Tapping SELECTS it (a ring, no value jump). Adjust by relative
// vertical drag or scroll wheel (a HORIZONTAL drag / shift-wheel slides the row it sits in
// instead — see hscrollRows.ts); double-click / right-click resets. (Arrow keys
// are intentionally NOT bound — they belong to the global deck keymap.)
//
// ★ EVERY PRESS ANSWERS. A cell is a BUTTONOID as much as a knob — a tap can toggle SYNC, a
// right-click can reset it or open a menu — and none of that used to acknowledge the press at
// all: a button gets :active for free, a div does not. Three states, in increasing loudness:
//   .tappable  — at rest / on hover, for a cell that HAS a tap action: the label lifts out of
//                grey. The quiet advertisement that there's a second thing in here.
//   .pressing  — while the pointer is held (including a value drag): "I have your pointer".
//                Cleared the moment the gesture is reclassified as a row-scroll — that press
//                belongs to the row now, and the cell must stop claiming it.
//   .pulsing   — a one-shot flash when a HIDDEN action actually fired (onTap, a right-click
//                reset/menu, a double-click reset). The value cells show their own result in
//                the number; these are the ones that otherwise showed nothing. See usePulse.
export function ValueCell({ label, value, min, max, step = 0.01, pivot, reset, onChange, format, className, disabled, children, style, onTap, kbd, active, onContextMenu }: ValueCellProps) {
  const el = useRef<HTMLDivElement>(null);
  // A press is classified ONCE, on its first move past the slop: mostly-vertical → this cell's
  // value drag; mostly-horizontal → it SLIDES the row the cell sits in (see hscrollRows.ts —
  // vertical belongs to the knob, horizontal to the row) and stops being a tap.
  const drag = useRef<{ startX: number; startY: number; startVal: number; moved: boolean; mode: "pending" | "value" | "scroll"; row: HTMLElement | null; startLeft: number } | null>(null);
  const lastTap = useRef(0);
  const [pressing, setPressing] = useState(false);
  const [pulseCls, pulse] = usePulse();
  const longPress = useRef<number | undefined>(undefined); // touch long-press → onContextMenu (the menu)
  const clearLong = () => { if (longPress.current) clearTimeout(longPress.current); longPress.current = undefined; };
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
      // shift+wheel or a horizontal wheel/trackpad swipe slides the ROW, not the value
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const row = scrollRowOf(node);
        if (row && wheelScrollRow(row, e)) e.preventDefault();
        return;
      }
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
      className={`vcell ${className ?? ""} ${bipolar ? "bipolar" : ""} ${disabled ? "disabled" : ""} ${active === false ? "muted" : ""} ${onTap ? "tappable" : ""} ${pressing ? "pressing" : ""} ${pulseCls}`}
      style={{ touchAction: "none", ...style }}
      onPointerDown={(e) => {
        if (disabled) return;
        // Right / middle button: let onContextMenu reset the value — don't start a
        // tap/drag (which would fire onTap, e.g. toggle a stem mute).
        if (e.button !== 0) return;
        el.current?.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        setPressing(true);
        // Double-tap / double-click resets.
        if (e.timeStamp - lastTap.current < 320) {
          onChange(resetTo);
          pulse(); // a reset onto the value it already held would otherwise show nothing
          lastTap.current = 0;
          drag.current = null;
          return;
        }
        lastTap.current = e.timeStamp;
        drag.current = { startX: e.clientX, startY: e.clientY, startVal: value, moved: false, mode: "pending", row: null, startLeft: 0 };
        // Touch has no right-click: a long-press opens the cell's menu (e.g. MIC → destination).
        // Cancelled by a drag (onPointerMove) or release; cancels the pending tap/drag when it fires.
        if (e.pointerType === "touch" && onContextMenu) {
          const px = e.clientX, py = e.clientY;
          clearLong();
          longPress.current = window.setTimeout(() => {
            navigator.vibrate?.(8);
            drag.current = null; // swallow the tap/drag that was in progress
            onContextMenu({ preventDefault() {}, clientX: px, clientY: py } as unknown as ReactMouseEvent);
          }, 460);
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = d.startY - e.clientY; // up = increase
        const dx = e.clientX - d.startX;
        if (d.mode === "pending") {
          if (Math.abs(dy) < TAP_SLOP && Math.abs(dx) < TAP_SLOP) return; // still a tap
          clearLong(); // a real drag → not a long-press
          d.moved = true;
          const row = Math.abs(dx) > Math.abs(dy) ? scrollRowOf(el.current) : null;
          if (row) {
            d.mode = "scroll";
            d.row = row;
            d.startLeft = row.scrollLeft;
            setPressing(false); // this press is the ROW's now, not the cell's
          } else d.mode = "value";
        }
        if (d.mode === "scroll") {
          d.row!.scrollLeft = d.startLeft - dx;
          return;
        }
        onChange(clampStep(d.startVal + (dy / DRAG_SPAN_PX) * span));
      }}
      onPointerUp={(e) => {
        clearLong();
        setPressing(false);
        const d = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        // A clean tap (pointer never moved past the slop) fires onTap — e.g. mute.
        if (d && !d.moved && onTap && !disabled) {
          onTap();
          pulse(); // the tap's RESULT lives elsewhere (a tick scale, a mute) — flash the cell you hit
        }
      }}
      onPointerCancel={() => { clearLong(); setPressing(false); }}
      onContextMenu={(e) => { e.preventDefault(); if (disabled) return; pulse(); if (onContextMenu) onContextMenu(e); else onChange(resetTo); }}
    >
      <KnobBorder value={value} min={min} max={max} pivot={pivot} />
      {children}
      <span className="vcell-label">{label}</span>
      {format && <span className="vcell-value">{format(value)}</span>}
      {kbd && <span className="kbd">{kbd}</span>}
    </div>
  );
}

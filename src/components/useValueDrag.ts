import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

interface Opts {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}

// Pixels of vertical drag spanning the whole range; movement under the slop is a tap.
const DRAG_SPAN_PX = 150;
const TAP_SLOP = 4;

// Turn an ordinary <button> into a tap-AND-scroll control: a clean tap still fires
// the element's own onClick (e.g. effect on/off), while the scroll wheel or a
// vertical drag adjust a value (e.g. the filter sweep). A drag suppresses the click
// that would otherwise follow, so adjusting never accidentally toggles. Spread the
// returned props onto the button and keep its existing onClick.
export function useValueDrag<T extends HTMLElement>({ value, min, max, step = 0.01, onChange, disabled }: Opts) {
  const ref = useRef<T | null>(null);
  const drag = useRef<{ y: number; v: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef({ value, min, max, step, onChange, disabled });
  latest.current = { value, min, max, step, onChange, disabled };

  const clamp = (v: number) => {
    const L = latest.current;
    const c = Math.max(L.min, Math.min(L.max, v));
    return L.step ? Math.round(c / L.step) * L.step : c;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const L = latest.current;
      if (L.disabled) return;
      e.preventDefault();
      const unit = Math.max((L.max - L.min) / 40, L.step || 0);
      L.onChange(clamp(L.value + (e.deltaY < 0 ? unit : -unit)));
    };
    // Native capture click-suppressor: after a drag, swallow the click before it
    // reaches React's delegated onClick (which would toggle the button).
    const onClick = (e: MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("click", onClick, true);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<T>) => {
    if (latest.current.disabled) return;
    drag.current = { y: e.clientY, v: latest.current.value, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<T>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY; // up = increase
    if (!d.moved && Math.abs(dy) < TAP_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      suppressClick.current = true;
      ref.current?.setPointerCapture(e.pointerId);
    }
    const L = latest.current;
    L.onChange(clamp(d.v + (dy / DRAG_SPAN_PX) * (L.max - L.min)));
  };
  const onPointerUp = (e: ReactPointerEvent<T>) => {
    if (drag.current?.moved) ref.current?.releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  return { ref, onPointerDown, onPointerMove, onPointerUp };
}

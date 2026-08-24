import { useRef, type TouchEvent as ReactTouchEvent } from "react";

// Touch long-press → the "alt action" a right-click triggers, so the config / reveal / routing
// menus that live on `onContextMenu` are reachable on touch (they were desktop-only = inaccessible
// on a tablet/phone). Mouse is untouched — it still has the real right-click. Movement past a small
// slop cancels it (so it never fires mid-drag/scroll); a short haptic tick fires on success so the
// gesture is FELT (its only discoverability cue today). One press at a time, so the timer/fired refs
// are shared; `bind(payload)` closes the handlers over a per-item payload for use inside a .map.
const LONG_PRESS_MS = 460;
const MOVE_CANCEL_PX = 12;

export function useLongPress<T = void>(onLongPress: (payload: T, x: number, y: number) => void, ms = LONG_PRESS_MS) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false); // did the last touch fire the long-press? (consumers swallow the tap)
  const start = useRef({ x: 0, y: 0 });

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const bind = (payload: T) => ({
    onTouchStart: (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      fired.current = false;
      start.current = { x: t.clientX, y: t.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(8);
        onLongPress(payload, start.current.x, start.current.y);
      }, ms);
    },
    onTouchMove: (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (t && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > MOVE_CANCEL_PX) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  });

  // ★ THE TWO GESTURES SHARE A PRESS. A finger that holds still opens the menu; a finger that holds
  // then MOVES reorders. Whichever commits first has to call the other off, or a slow drag that
  // pauses under the long-press slop opens a menu on top of itself. This is that call.
  return { bind, fired, cancel: clear };
}

import { useEffect, useRef } from "react";

/** How long the pointer may be over neither the window nor the row that opened it before the window
 *  closes. Long enough to cross the gap between the two — which belongs to neither and is the whole
 *  reason this is a grace and not an edge. */
const GRACE_MS = 140;

/** ★ A HOVER-OPENED WINDOW IS DISMISSED BY A PREDICATE, NOT BY A RACE OF ENTER/LEAVE.
 *
 *  Five of these windows shipped closing only from their own `onMouseLeave`, and every one of them
 *  could be stranded on screen — a flyout opened by hovering a section heading is never entered at
 *  all if you change your mind, so nothing ever fires its leave. Two more paths break it even when
 *  you do: an element that UNMOUNTS under the pointer fires no leave (every re-render of a list
 *  does that), and a leave fired by the window a row lived in arms a close while the pointer is
 *  already inside the child.
 *
 *  mouseenter/mouseleave are EDGES; "is this window still wanted" is a STATE. Deriving the state
 *  from edges only works if you can enumerate every edge, and you cannot. So: keep the edges for
 *  the OPEN — they are precise, instant, and name their target — and ask the real pointer the real
 *  question for the CLOSE. While the window is up, every pointermove checks whether the pointer is
 *  over the window or over what opened it; anything else starts the grace, which continuous
 *  movement keeps postponing (so the gap stays crossable) and stopping anywhere else spends.
 *
 *  `key` doubles as the switch: null (a menu open above it, a drag running, nothing shown) means no
 *  listener at all, so this costs nothing whenever no such window is on screen.
 */
export function useHoverDismiss(key: string | null, keep: readonly string[], close: () => void) {
  const cb = useRef({ keep, close });
  cb.current = { keep, close };
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
    };
    if (!key) return clear;
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      // `closest` and not `matches`: the pointer is almost always over a CHILD of the thing that
      // counts — a button inside the row, a label inside the window.
      if (el && cb.current.keep.some((sel) => el.closest(sel))) return clear();
      clear();
      timer.current = window.setTimeout(() => cb.current.close(), GRACE_MS);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      clear();
    };
  }, [key]);
}

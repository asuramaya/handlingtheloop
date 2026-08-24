import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// ★ ONE DRAG, MOUSE AND TOUCH. Reordering used to be HTML5 drag-and-drop, which does not exist on
// touch — so touch was given ◀ ▶ buttons in a menu instead, and the two surfaces did the same job
// with two unrelated gestures. This is the pointer-event drag that lets them share one: hit-test
// by coordinate, so the same code path serves a mouse, a finger and a stylus.
//
// The one real difference between them is what the gesture COSTS to start. A mouse has a spare
// button and no other use for a horizontal drag; a finger's horizontal drag is how you scroll the
// row. So a finger has to say it means it: the drag ARMS after a short still hold (the row scrolls
// freely before that), while a mouse arms on the first pixel. That is the standard reorder gesture
// on every touch OS, and it costs the mouse nothing.
//
// It coexists with useLongPress (the touch stand-in for right-click): the menu fires at 460 ms of
// stillness, this arms at 180 ms but only BECOMES a drag on movement — so hold-still opens the
// menu, hold-then-move reorders, and whichever happens first cancels the other.
const TOUCH_ARM_MS = 180;
const SLOP_PX = 6;

export interface ReorderDrag {
  /** Index currently being dragged, or null. */
  from: number | null;
  /** INSERTION point 0..len (the gap the drop would land in), or null. */
  at: number | null;
  /** Id of the foreign drop target under the pointer (see `foreign`), or null. */
  onto: string | null;
  /** Spread onto each draggable item, with its index. */
  bind: (i: number) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    "data-drag": number;
  };
  /** Spread onto the row container that holds the draggable items. */
  row: { "data-group": string; "data-row": boolean };
  /** Abandon an armed or running drag — the long-press menu calls this when it wins the press. */
  cancel: () => void;
  /** Spread onto a thing a dragged item can be dropped ON (rather than between). */
  foreign: (id: string) => { "data-drop": string; "data-group": string };
}

export function useReorderDrag(opts: {
  /** Unique per row, so two rows on screen never hit-test into each other. */
  group: string;
  /** Reorder within the row: `from` is the item's index, `at` the insertion point 0..len. */
  onReorder: (from: number, at: number) => void;
  /** Dropped onto a foreign target instead of between items. */
  onDropOn?: (from: number, id: string) => void;
  /** Called when a drag actually starts — used to swallow the click that follows. */
  onStart?: (from: number) => void;
}): ReorderDrag {
  const [from, setFrom] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [onto, setOnto] = useState<string | null>(null);
  // Everything the live gesture needs, in a ref: the window listeners are installed once and must
  // never read a stale render's closure.
  const g = useRef<{
    idx: number;
    armed: boolean;
    dragging: boolean;
    x: number;
    y: number;
    timer?: number;
    touch: boolean;
  } | null>(null);
  const cb = useRef(opts);
  cb.current = opts;

  const end = () => {
    const cur = g.current;
    if (cur?.timer) clearTimeout(cur.timer);
    g.current = null;
    setFrom(null);
    setAt(null);
    setOnto(null);
    return cur;
  };

  useEffect(() => {
    // A touch drag has to stop the row from scrolling under it, and that needs a NON-PASSIVE
    // listener — React registers touchmove passively at the root, so preventDefault() there does
    // nothing. Hence a manual window listener. It only ever preventDefault()s once the drag is
    // actually running, so an ordinary scroll is untouched.
    const move = (e: PointerEvent) => {
      const cur = g.current;
      if (!cur) return;
      const moved = Math.hypot(e.clientX - cur.x, e.clientY - cur.y);
      if (!cur.dragging) {
        if (!cur.armed || moved < SLOP_PX) return;
        cur.dragging = true;
        setFrom(cur.idx);
        cb.current.onStart?.(cur.idx);
      }
      const hit = hitTest(e.clientX, e.clientY, cb.current.group, cur.idx);
      setAt(hit.at);
      setOnto(hit.onto);
    };
    const touchMove = (e: TouchEvent) => {
      if (g.current?.dragging) e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      const cur = g.current;
      if (!cur) return;
      const dragging = cur.dragging;
      const idx = cur.idx;
      const hit = dragging ? hitTest(e.clientX, e.clientY, cb.current.group, idx) : { at: null, onto: null };
      end();
      if (!dragging) return;
      if (hit.onto != null) cb.current.onDropOn?.(idx, hit.onto);
      else if (hit.at != null) cb.current.onReorder(idx, hit.at);
    };
    const cancel = () => end();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", touchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", touchMove);
    };
  }, []);

  return {
    from,
    at,
    onto,
    bind: (i: number) => ({
      "data-drag": i,
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button != null && e.button > 0) return; // right-click is the menu, not a drag
        const touch = e.pointerType === "touch";
        g.current = { idx: i, armed: !touch, dragging: false, x: e.clientX, y: e.clientY, touch };
        if (touch) {
          const cur = g.current;
          cur.timer = window.setTimeout(() => {
            if (g.current === cur) cur.armed = true;
          }, TOUCH_ARM_MS);
        }
      },
    }),
    cancel: () => { end(); },
    row: { "data-group": opts.group, "data-row": true },
    foreign: (id: string) => ({ "data-drop": id, "data-group": opts.group }),
  };
}

/** What is under the pointer: an insertion point between this row's items, or a foreign target.
 *  Coordinate hit-testing (rather than dragover events) is what makes one code path serve every
 *  pointer type — a finger fires no dragover, but it has coordinates like everything else. */
function hitTest(x: number, y: number, group: string, self: number): { at: number | null; onto: string | null } {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const drop = el?.closest<HTMLElement>(`[data-drop][data-group="${group}"]`);
  if (drop) return { at: null, onto: drop.dataset.drop ?? null };
  const row = document.querySelector<HTMLElement>(`[data-group="${group}"][data-row]`);
  if (!row) return { at: null, onto: null };
  const items = [...row.querySelectorAll<HTMLElement>("[data-drag]")];
  if (!items.length) return { at: null, onto: null };
  // Outside the row entirely (vertically) — no drop, so a stray drag simply does nothing.
  const rr = row.getBoundingClientRect();
  if (y < rr.top - 24 || y > rr.bottom + 24) return { at: null, onto: null };
  const centers = items.map((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  return { at: pickInsertion(centers, x, self), onto: null };
}

/** Which GAP the pointer is in: 0 = before the first item, n = after the last. Null when it is one
 *  of the two gaps either side of the dragged item — both of those are "where it already is", and
 *  a drop indicator that appears at the item's own edges reads as a move that will do nothing.
 *  Pure, and the only arithmetic in the drag, so it is the part worth testing. */
export function pickInsertion(centers: readonly number[], x: number, self: number): number | null {
  let p = centers.length;
  for (let i = 0; i < centers.length; i++) {
    if (x < centers[i]) {
      p = i;
      break;
    }
  }
  return p === self || p === self + 1 ? null : p;
}

/** An insertion point is a GAP, an index is a SLOT. Pulling the source out first shifts everything
 *  after it down one, so a rightward move lands one short of its gap. Every caller of onReorder
 *  does this, which is why it is written down once. */
export function insertionToIndex(from: number, at: number): number {
  return from < at ? at - 1 : at;
}

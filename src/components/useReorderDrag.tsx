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
// Auto-scroll: how close to a scrolling container's edge counts as "at the edge", and how fast it
// creeps there. A list capped at 240px cannot be reordered end-to-end without it — the item you are
// dragging simply runs out of list.
const EDGE_PX = 26;
const EDGE_SPEED = 9; // px per frame at the very edge, ramped down to 0 at EDGE_PX away
// How much of a drop target that is ALSO a row is reserved at each end for "insert beside" rather
// than "drop into" — a quarter each, so the middle half still reads as a generous into-target.
const INTO_BAND = 0.25;
const INTO_BAND_MAX = 9;
// How far ACROSS the list's axis the pointer may stray and still be reordering it. 28 was tight
// enough that an ordinary wrist drift down a 168px menu dropped the indicator — which reads as the
// list going dead rather than as a deliberate "you have left".
const CROSS_SLOP = 48;

/** The nearest ancestor that actually scrolls along `axis` — NOT the row container, which usually
 *  does not. The centres are snapshotted in CONTENT coordinates (viewport + scroll), so the live
 *  scroll offset has to come from the element that really moves, or a list that scrolls mid-drag
 *  hit-tests against where the rows used to be. */
function scrollerOf(el: HTMLElement | undefined, vert: boolean): HTMLElement | null {
  for (let n: HTMLElement | null = el ?? null; n; n = n.parentElement) {
    const st = getComputedStyle(n);
    const ov = vert ? st.overflowY : st.overflowX;
    if ((ov === "auto" || ov === "scroll") && (vert ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth)) return n;
  }
  return null;
}
const scrollOf = (el: HTMLElement | null, vert: boolean) => (el ? (vert ? el.scrollTop : el.scrollLeft) : 0);

export interface ReorderDrag {
  /** Index currently being dragged, or null. */
  from: number | null;
  /** INSERTION point 0..len (the gap the drop would land in), or null. */
  at: number | null;
  /** Id of the foreign drop target under the pointer (see `foreign`), or null. */
  onto: string | null;
  /** ★ WHERE INSIDE a foreign target that is itself a LIST the drop would land, or null when the
   *  target is not one. `at` stays null whenever `onto` is set — the two indices belong to two
   *  different lists, and rendering the source list's drop line from a foreign hit is how a
   *  "leave this group" drag ends up drawing a gap in the group it is leaving. */
  intoAt: number | null;
  /** Spread onto each draggable item, with its index. */
  bind: (i: number) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    "data-drag": number;
  };
  /** Spread onto the row container that holds the draggable items. */
  row: { "data-group": string; "data-row": boolean; "data-drop-list": boolean };
  /** Abandon an armed or running drag — the long-press menu calls this when it wins the press. */
  cancel: () => void;
  /** Spread onto a thing a dragged item can be dropped ON (rather than between). */
  foreign: (id: string) => { "data-drop": string; "data-group": string };
}

export function useReorderDrag(opts: {
  /** Unique per row, so two rows on screen never hit-test into each other. */
  group: string;
  /** Which way the items run. "x" (the default) is the FX tab strip and the chain chips; "y" is a
   *  menu list. It was x-only, hard-coded in the centre maths — a vertical list hit-tested against
   *  horizontal centres puts every insertion point in the wrong gap, which reads as a reorder that
   *  ignores you. `pickInsertion` itself is axis-free and is unchanged. */
  axis?: "x" | "y";
  /** Reorder within the row: `from` is the item's index, `at` the insertion point 0..len. */
  onReorder: (from: number, at: number) => void;
  /** Dropped onto a foreign target instead of between items. `group` is that target's own
   *  data-group, which is what distinguishes "a section heading" from "the list's background" when
   *  a drag accepts more than one kind. */
  onDropOn?: (from: number, id: string, group: string, at: number | null) => void;
  /** Called when a drag actually starts — used to swallow the click that follows. */
  onStart?: (from: number) => void;
  /** ★ FLOAT A CLONE instead of transforming the row in place. Required whenever the list lives
   *  inside a clipping box: a transformed child of `overflow: auto` is still CLIPPED BY IT, so in a
   *  240px-capped menu the thing you are dragging is cut off at the edge and can never visibly
   *  reach a target outside — it reads as a drag that refuses to leave. The clone is `position:
   *  fixed`, which escapes ancestor overflow (nothing here establishes a containing block), while
   *  the real row STAYS IN FLOW as a dimmed placeholder — which is also what keeps the snapshotted
   *  centres valid, since lifting it out would collapse the list under its own hit-test.
   *  Off by default: the tab and chain strips have transformed in place since day one and their
   *  lift styling is written for it. */
  ghost?: boolean;
  /** Foreign drop targets belonging to OTHER groups that this drag may also land on — how an item
   *  moves between two lists that are on screen together. Each `[data-drop]` is matched on its own
   *  `data-group`, and the group is handed to onDropOn so the caller can tell them apart. */
  accept?: string[];
  /** Whether THIS item may land on THAT target — asked per hit, not per list. A drop the model will
   *  refuse must not light up as one it will accept: a section dragged over another section used to
   *  outline the heading and then do nothing, because the arrangement is one level deep and filing
   *  a group into a group is a no-op. Returning false does not kill the drop, it makes the target
   *  transparent: the hit falls through to whatever encloses it, or to an ordinary insertion. */
  canDropOn?: (from: number, id: string, group: string) => boolean;
}): ReorderDrag {
  const [from, setFrom] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [onto, setOnto] = useState<string | null>(null);
  const [intoAt, setIntoAt] = useState<number | null>(null);
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
    el: HTMLElement; // the pill itself — it FLOATS, driven imperatively (see below)
    row?: HTMLElement;
    /** Item centres in ROW-CONTENT coordinates, snapshotted at drag start. ★ They must not be
     *  re-measured mid-drag: the drop gap widens the row, which would move the very centres the
     *  gap was decided from, and the decision would oscillate across the boundary. The layout you
     *  are deciding against is the one you started from. */
    centers: number[];
    ghost: HTMLElement | null;
    scroller: HTMLElement | null;
    vert: boolean;
    /** Live pointer position, for the auto-scroll loop (which runs on its own rAF, not on move). */
    px: number;
    py: number;
    raf: number;
  } | null>(null);
  const cb = useRef(opts);
  cb.current = opts;

  const end = () => {
    const cur = g.current;
    if (cur?.timer) clearTimeout(cur.timer);
    if (cur?.raf) cancelAnimationFrame(cur.raf);
    if (cur) {
      cur.ghost?.remove();
      cur.el.style.transform = "";
      cur.el.classList.remove("is-dragging", "reorder-source");
    }
    g.current = null;
    setFrom(null);
    setAt(null);
    setOnto(null);
    setIntoAt(null);
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
      cur.px = e.clientX;
      cur.py = e.clientY;
      const moved = Math.hypot(e.clientX - cur.x, e.clientY - cur.y);
      if (!cur.dragging) {
        if (!cur.armed || moved < SLOP_PX) return;
        cur.dragging = true;
        // Also set from React state (see the caller): a re-render would otherwise rewrite
        // className and strip this class off mid-drag. This one is for the very first frame.
        if (cb.current.ghost) {
          const r = cur.el.getBoundingClientRect();
          const gh = cur.el.cloneNode(true) as HTMLElement;
          gh.classList.add("reorder-ghost", "is-dragging");
          // ★ Z-INDEX INLINE, NOT IN THE STYLESHEET. The clone keeps the source's classes so it
          // inherits the list's own look, and one of those is `is-dragging` — whose rule is a
          // TWO-class selector (`.fx-preset-row.is-dragging { z-index: 30 }`) and therefore beats
          // single-class `.reorder-ghost` on specificity however large a number that rule names.
          // The ghost measured z-index 30 and painted UNDER the very menu it was dragged out of.
          // An inline declaration outranks every class rule, and cannot be lost to the next one
          // somebody adds.
          gh.style.cssText += `;position:fixed;z-index:2147483000;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;`;
          document.body.appendChild(gh);
          cur.ghost = gh;
          cur.el.classList.add("reorder-source");
        } else cur.el.classList.add("is-dragging");
        setFrom(cur.idx);
        cb.current.onStart?.(cur.idx);
        if (cur.scroller) cur.raf = requestAnimationFrame(edgeScroll);
      }
      // ★ THE FLOAT IS IMPERATIVE. It moves every pointermove; the insertion point changes only
      // when a boundary is crossed. Rendering the pill's position through React state would
      // re-render the whole strip at pointer rate for a transform — so the transform is written
      // straight to the node and only the (rare) drop decision goes through state.
      const t = `translate3d(${e.clientX - cur.x}px, ${e.clientY - cur.y}px, 0) scale(1.06)`;
      if (cur.ghost) cur.ghost.style.transform = t;
      else cur.el.style.transform = t;
      const hit = hitTest(e.clientX, e.clientY, cb.current.group, cur, cb.current.accept, cb.current.canDropOn);
      setAt(hit.at);
      setOnto(hit.onto);
      setIntoAt(hit.intoAt ?? null);
    };
    // ★ AUTO-SCROLL, on its own rAF rather than on pointermove: at the edge of a capped list the
    // pointer STOPS MOVING (you are already as far as you can go), so a scroll driven by move
    // events stalls exactly when it is needed. Runs while the drag runs, ramps with how close to
    // the edge you are, and re-hit-tests each frame so the insertion point tracks the scroll.
    const edgeScroll = () => {
      const cur = g.current;
      if (!cur?.dragging || !cur.scroller) return;
      const sc = cur.scroller;
      const r = sc.getBoundingClientRect();
      const p = cur.vert ? cur.py : cur.px;
      const lo = (cur.vert ? r.top : r.left) + EDGE_PX;
      const hi = (cur.vert ? r.bottom : r.right) - EDGE_PX;
      let d = 0;
      if (p < lo) d = -Math.min(1, (lo - p) / EDGE_PX) * EDGE_SPEED;
      else if (p > hi) d = Math.min(1, (p - hi) / EDGE_PX) * EDGE_SPEED;
      if (d) {
        if (cur.vert) sc.scrollTop += d;
        else sc.scrollLeft += d;
        const hit = hitTest(cur.px, cur.py, cb.current.group, cur, cb.current.accept, cb.current.canDropOn);
        setAt(hit.at);
        setOnto(hit.onto);
        setIntoAt(hit.intoAt ?? null);
      }
      cur.raf = requestAnimationFrame(edgeScroll);
    };

    const touchMove = (e: TouchEvent) => {
      if (g.current?.dragging) e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      const cur = g.current;
      if (!cur) return;
      const dragging = cur.dragging;
      const idx = cur.idx;
      const hit = dragging ? hitTest(e.clientX, e.clientY, cb.current.group, cur, cb.current.accept, cb.current.canDropOn) : { at: null, onto: null, group: null, intoAt: null };
      end();
      if (!dragging) return;
      if (hit.onto != null) cb.current.onDropOn?.(idx, hit.onto, hit.group ?? cb.current.group, hit.intoAt ?? null);
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
    intoAt,
    bind: (i: number) => ({
      "data-drag": i,
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button != null && e.button > 0) return; // right-click is the menu, not a drag
        const touch = e.pointerType === "touch";
        const el = e.currentTarget as HTMLElement;
        const row = document.querySelector<HTMLElement>(`[data-group="${opts.group}"][data-row]`) ?? undefined;
        const vert = opts.axis === "y";
        const scroller = scrollerOf(row ?? el, vert);
        const s0 = scrollOf(scroller, vert);
        const centers = row
          ? [...row.querySelectorAll<HTMLElement>("[data-drag]")].map((n) => {
              const r = n.getBoundingClientRect();
              return (vert ? r.top + r.height / 2 : r.left + r.width / 2) + s0;
            })
          : [];
        g.current = { idx: i, armed: !touch, dragging: false, x: e.clientX, y: e.clientY, touch, el, row, centers, ghost: null, scroller, vert, px: e.clientX, py: e.clientY, raf: 0 };
        if (touch) {
          const cur = g.current;
          cur.timer = window.setTimeout(() => {
            if (g.current === cur) cur.armed = true;
          }, TOUCH_ARM_MS);
        }
      },
    }),
    cancel: () => { end(); },
    // `data-drop-list` marks this as a list a FOREIGN drag can be asked to land at a position in —
    // see hitTest. Costs the owning drag nothing; it is only ever read through a [data-drop].
    row: { "data-group": opts.group, "data-row": true, "data-drop-list": true },
    foreign: (id: string) => ({ "data-drop": id, "data-group": opts.group }),
  };
}

/** What is under the pointer: an insertion point between this row's items, or a foreign target.
 *  Coordinate hit-testing (rather than dragover events) is what makes one code path serve every
 *  pointer type — a finger fires no dragover, but it has coordinates like everything else. */
function hitTest(
  x: number,
  y: number,
  group: string,
  g: { idx: number; row?: HTMLElement; centers: number[]; vert?: boolean; scroller?: HTMLElement | null },
  accept?: string[],
  can?: (from: number, id: string, group: string) => boolean,
): { at: number | null; onto: string | null; group?: string | null; intoAt?: number | null } {
  // The floating pill is pointer-events: none while it drags, so this reads what is UNDER it.
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const groups = accept?.length ? [group, ...accept] : [group];
  const sel = groups.map((gp) => `[data-drop][data-group="${gp}"]`).join(",");
  const row = g.row;
  // ★ THE OUTER BAND FALLS THROUGH TO THE NEXT TARGET OUT, not to a fixed second choice. Drop
  // targets NEST here — a section heading sits inside the wrapper that means "the top level" — and
  // the band at each end of a heading is how you say "beside this section" rather than "in it".
  // That only worked for the list's OWN drag, which had an insertion to fall through to; a drag
  // arriving from the other window treated every heading as wholly "file it in here", so a row
  // leaving a group could be put at the END of the top level (the landing strip) and nowhere else.
  // Walking outward makes one rule serve both: miss the middle of a target and you are asking about
  // whatever contains it.
  for (let node: HTMLElement | null = el; node; ) {
    const drop = node.closest<HTMLElement>(sel);
    if (!drop) break;
    // ★ A TARGET THAT IS ALSO A ROW GETS BANDS. A section heading is both a draggable row and a
    // drop-INTO target, so covering all of it with "into" made every pass over one mean "file it in
    // here" — and a preset could never be reordered to sit next to a section at all, because the
    // only way to reach that gap is across the heading. The middle half is INTO; the outer quarters
    // fall through to an ordinary insertion, which is the same bargain every tree view makes.
    // Targets that are NOT rows of this list (a chain chip under a dragged device) stay wholly
    // "into" — there is no gap there to fall through to.
    // ★ BANDS ONLY WHERE THERE IS SOMEWHERE TO FALL. A band is a way of saying "not this one, the
    // thing around it" — so a target with nothing around it and no insertion behind it must stay
    // wholly "into", or its two ends become dead pixels that swallow the drop. A chain chip under a
    // dragged device tab is exactly that: one target, no gap, no outer.
    const outer = drop.parentElement?.closest<HTMLElement>(sel) ?? null;
    const own = !!row && row.contains(drop);
    let into = true;
    if (drop.hasAttribute("data-drag") && (own || outer)) {
      const dr = drop.getBoundingClientRect();
      into = isIntoTarget(g.vert ? y - dr.top : x - dr.left, (g.vert ? dr.height : dr.width) || 1);
    }
    if (into && can && !can(g.idx, drop.dataset.drop ?? "", drop.dataset.group ?? "")) into = false;
    if (into) {
      // ★ A FOREIGN TARGET MAY ITSELF BE A LIST. "Move this out of its group" is not one act, it is
      // "put it HERE in the other list" — and a target that answers only yes/no can only ever drop
      // at some index the code picked, which is never the one under the pointer. So a target that
      // carries (or contains) [data-drop-list] is asked WHERE as well as WHETHER.
      // Measured LIVE, not snapshotted: this list is not the one being reordered, so nothing is
      // lifting out of it and its layout is stable — the only thing this drag adds to it is a
      // zero-height drop line, which is exactly why that line has no height.
      const list = drop.matches("[data-drop-list]") ? drop : drop.querySelector<HTMLElement>("[data-drop-list]");
      let intoAt: number | null = null;
      if (list) {
        const cs = [...list.querySelectorAll<HTMLElement>("[data-drag]")].map((n) => {
          const r = n.getBoundingClientRect();
          return g.vert ? r.top + r.height / 2 : r.left + r.width / 2;
        });
        // self = -2: nothing in THIS list is being dragged out of it, so no gap is "where it
        // already is" and every insertion point is real. (-1 would silently suppress gap 0, which
        // is `self + 1`.)
        intoAt = pickInsertion(cs, g.vert ? y : x, -2);
      }
      return { at: null, onto: drop.dataset.drop ?? null, group: drop.dataset.group ?? null, intoAt };
    }
    // Its own list's heading: the fall-through is this list's own insertion, computed below.
    if (own) break;
    node = outer;
  }
  if (!row || !g.centers.length) return { at: null, onto: null };
  // Outside the row entirely ACROSS its axis — no drop, so a stray drag simply does nothing.
  const rr = row.getBoundingClientRect();
  // Centres were snapshotted in CONTENT coordinates; the pointer is in viewport ones. Adding the
  // scroller's CURRENT offset converts it, which is also what lets the list scroll under a live
  // drag (auto-scroll, or the user's own wheel) without every gap decision going stale.
  const sc = g.scroller ? (g.vert ? g.scroller.scrollTop : g.scroller.scrollLeft) : 0;
  if (g.vert) {
    if (x < rr.left - CROSS_SLOP || x > rr.right + CROSS_SLOP) return { at: null, onto: null };
    return { at: pickInsertion(g.centers, y + sc, g.idx), onto: null };
  }
  if (y < rr.top - CROSS_SLOP || y > rr.bottom + CROSS_SLOP) return { at: null, onto: null };
  return { at: pickInsertion(g.centers, x + sc, g.idx), onto: null };
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

/** Is a press this far into a target that is ALSO a row a "drop INTO it", or an insertion beside
 *  it? A quarter at each end belongs to the gaps, capped at INTO_BAND_MAX px so a tall row does not
 *  surrender a lot of area to dead bands. Pure, and the only arithmetic in the decision, so it is
 *  the part worth testing — the whole-target version of this rule made it impossible to reorder a
 *  preset into the gap beside a section, because the only route to that gap is across the heading. */
export function isIntoTarget(offset: number, size: number): boolean {
  const band = Math.min(size * INTO_BAND, INTO_BAND_MAX);
  return offset > band && offset < size - band;
}

/** ★ THE GAP, DRAWN. `at` was computed from the first version and rendered by nobody: the only
 *  feedback a reorder gave was the pill going translucent, so you dropped and found out. A list
 *  reorder has exactly one question — WHERE WILL IT LAND — and this answers it in the place the
 *  answer belongs. Render it before row i when `at === i`, and once more after the last row when
 *  `at === len`; it is null the rest of the time and at the two gaps either side of the dragged
 *  item, which are "where it already is".
 *
 *  Kept here rather than in a caller because every list that uses this hook needs the same thing,
 *  and a drop indicator that differs per list is how two surfaces drift apart. */
export function DropLine({ show, axis = "y" }: { show: boolean; axis?: "x" | "y" }) {
  return show ? <i className={`reorder-drop-line ${axis}`} aria-hidden="true" /> : null;
}

/** An insertion point is a GAP, an index is a SLOT. Pulling the source out first shifts everything
 *  after it down one, so a rightward move lands one short of its gap. Every caller of onReorder
 *  does this, which is why it is written down once. */
export function insertionToIndex(from: number, at: number): number {
  return from < at ? at - 1 : at;
}

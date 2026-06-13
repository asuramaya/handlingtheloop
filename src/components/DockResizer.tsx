import { useRef } from "react";

// Restore any persisted dock / sidebar widths before the panels first paint, so a
// resized dock comes back at its chosen width on reload (no flash of the default).
for (const v of ["--dock-w-left", "--dock-w-right", "--lib-side-w"]) {
  try {
    const saved = localStorage.getItem(`htl:${v}`);
    if (saved) document.documentElement.style.setProperty(v, saved);
  } catch {
    /* ignore */
  }
}

type Measure = "parent" | "prev";

interface Props {
  varName: string; // CSS custom property (on <html>) this handle drives
  measure: Measure; // where the starting width is read: the handle's parent, or
  //   its previous sibling (the element actually being sized)
  min?: number;
  max?: number;
}

// A drag handle that resizes a desktop panel by writing a CSS custom property on
// <html> and persisting it to localStorage. Used for the Library/Search docks
// (measure the backdrop = parent) and the Library's inner sidebar (measure its
// previous sibling). Hidden on mobile, where the docks are centered modals.
//
// The grow DIRECTION is derived from geometry at grab time (which side of the sized
// element the handle sits on) rather than a fixed prop — so it stays correct after
// the docks are swapped left↔right (the handle moves to the inner edge via CSS, and
// this picks up the new side automatically).
export function DockResizer({ varName, measure, min = 220, max = 920 }: Props) {
  const data = useRef({ x: 0, w: 0, sign: 1 });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the dock backdrop treat this as a click-to-close
    const handle = e.currentTarget;
    const target = (measure === "parent" ? handle.parentElement : handle.previousElementSibling) as HTMLElement | null;
    if (!target) return;
    const handleRect = handle.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    // If the handle sits on the target's RIGHT half, dragging right widens it (+dx);
    // if it's on the left half (e.g. after a side-swap), dragging right shrinks it.
    const sign = handleRect.left + handleRect.width / 2 >= targetRect.left + targetRect.width / 2 ? 1 : -1;
    data.current = { x: e.clientX, w: targetRect.width, sign };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const root = document.documentElement;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - data.current.x) * data.current.sign;
      const w = Math.max(min, Math.min(max, data.current.w + dx));
      root.style.setProperty(varName, `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(`htl:${varName}`, root.style.getPropertyValue(varName));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className={`dock-resizer ${measure === "prev" ? "dock-resizer-inline" : "dock-resizer-edge"}`}
      onPointerDown={onPointerDown}
      title="Drag to resize"
    />
  );
}

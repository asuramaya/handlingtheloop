import { useEffect, useRef, useState } from "react";
import type { PanelKey } from "@htl";
import { type PanelPlacement, isResizable } from "@htl";

// Restore any persisted dock / sidebar / center widths before the panels first paint, so a
// resized panel comes back at its chosen size on reload (no flash of the default). Each
// "center"-placed panel gets its OWN var (see --center-w-* in board.css) rather than sharing
// one the way left/right docks share --dock-w-left/right, since any number of panels can be
// centered at once — there's no single edge to attribute a shared width to.
for (const v of [
  "--dock-w-left",
  "--dock-w-right",
  "--lib-side-w",
  "--dock-h-bottom",
  "--center-w-library",
  "--center-w-settings",
  "--center-w-people",
  "--center-w-session",
]) {
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
  // The :root custom properties holding this handle's usable [floor, ceiling]. Defaults to
  // the dock range; the Library's inner sidebar passes its own, because ONE source of truth
  // means one per resizable thing — a 200px sidebar must not inherit a 300px dock floor.
  rangeVars?: [string, string];
  // "x" (default) drags a WIDTH — left/right docks, the inner sidebar split. "y" drags a
  // HEIGHT — only the Library's bottom-sheet mode needs this so far, whose one edge (top)
  // is fixed geometry (the sheet is pinned to the viewport's bottom edge), unlike x's
  // grow-direction-by-geometry generality.
  axis?: "x" | "y";
  // How many px the SIZE grows per px the pointer moves. 1 (default) for an edge dock, where
  // the dragged edge IS the element's only moving edge. 2 for a "center" panel's symmetric
  // resize: it's centered by its container's flexbox, so growing its width by ΔW moves EACH
  // edge outward by ΔW/2 — dragging the edge the mouse is actually on 1:1 with the cursor
  // needs ΔW = 2 × the pointer's own movement.
  scale?: number;
  // Override the auto-picked shape class (edge/edge-y/inline) — the two "center" handles need
  // an explicit left/right variant regardless of axis or measure, since a centered panel has
  // no ancestor dock-left/dock-right class for the default edge variant to key off.
  edgeClassName?: string;
}

// The drag range comes from the SAME :root custom properties the dock CSS clamps with
// (--dock-min / --dock-max in board.css), so there is one answer to "how wide may a dock
// be" instead of two. This file used to hardcode 220..920 while the CSS clamped 280..520;
// the handle won both ends, and a dock dragged past the CSS cap was never capped at all
// because the max-width was derived from the stored width itself.
// Falls back to the passed props if the properties are missing (non-dock handles, or a
// stylesheet that hasn't loaded), so a caller can still override per handle.
function rootPx(prop: string, fallback: number): number {
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(prop));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
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
export function DockResizer({ varName, measure, min = 300, max = 560, rangeVars = ["--dock-min", "--dock-max"], axis = "x", scale = 1, edgeClassName }: Props) {
  const data = useRef({ pos: 0, size: 0, sign: 1 });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the dock backdrop treat this as a click-to-close
    const handle = e.currentTarget;
    const target = (measure === "parent" ? handle.parentElement : handle.previousElementSibling) as HTMLElement | null;
    if (!target) return;
    const handleRect = handle.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    let sign: number;
    if (axis === "y") {
      // If the handle sits on the target's BOTTOM half, dragging down grows it (+dy);
      // top half (the bottom-sheet's only case today: its handle sits at its own top
      // edge, the sheet's bottom edge is pinned to the viewport) means dragging UP grows
      // it, so this still falls out of the same geometry check as the x-axis one below.
      sign = handleRect.top + handleRect.height / 2 >= targetRect.top + targetRect.height / 2 ? 1 : -1;
    } else {
      // If the handle sits on the target's RIGHT half, dragging right widens it (+dx);
      // if it's on the left half (e.g. after a side-swap), dragging right shrinks it.
      sign = handleRect.left + handleRect.width / 2 >= targetRect.left + targetRect.width / 2 ? 1 : -1;
    }
    data.current = { pos: axis === "y" ? e.clientY : e.clientX, size: axis === "y" ? targetRect.height : targetRect.width, sign };
    // Read the range at GRAB time, not module load: the dock range vars are viewport-
    // independent today but resolving them per drag costs nothing and survives them
    // becoming responsive later.
    const lo = rootPx(rangeVars[0], min);
    const hi = rootPx(rangeVars[1], max);
    document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    const root = document.documentElement;
    const onMove = (ev: PointerEvent) => {
      const d = ((axis === "y" ? ev.clientY : ev.clientX) - data.current.pos) * data.current.sign * scale;
      const s = Math.max(lo, Math.min(hi, data.current.size + d));
      root.style.setProperty(varName, `${s}px`);
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
      className={`dock-resizer ${edgeClassName ?? (axis === "y" ? "dock-resizer-edge-y" : measure === "prev" ? "dock-resizer-inline" : "dock-resizer-edge")}`}
      onPointerDown={onPointerDown}
    />
  );
}

// Any top-level floating panel (Library, Settings, People…) picks the right resize handle for
// its own current placement — everything but "center" (that one's CenterResizeHandles below,
// rendered separately since it has to sit INSIDE the panel card, not beside the backdrop; see
// its own comment for why). The width/height vars here are shared across whichever panel
// currently occupies that EDGE ("the left dock's remembered width", not "Library's remembered
// width"), matching how only one panel can occupy an edge's screen space at once anyway.
export function DockPlacementResizer({ mode }: { mode: PanelPlacement }) {
  // A "sheet" fills its screen — there is no edge to pull and no size a drag could mean. This
  // returning null is what makes that structural rather than a stylesheet's `display: none`:
  // the handle is not hidden on a phone, it is never built. (It used to be built and hidden,
  // which is why a touch could still land on a 10px invisible strip at the panel's edge.)
  if (!isResizable(mode)) return null;
  if (mode === "left") return <DockResizer varName="--dock-w-left" measure="parent" />;
  if (mode === "right") return <DockResizer varName="--dock-w-right" measure="parent" />;
  if (mode === "bottom") {
    return (
      <DockResizer
        varName="--dock-h-bottom"
        measure="parent"
        axis="y"
        min={220}
        max={820}
        rangeVars={["--dock-h-min", "--dock-h-max"]}
      />
    );
  }
  return null;
}

// "center" placement's own resize: two handles, one on each edge of the PANEL CARD itself
// (not the backdrop — the backdrop is a full-viewport dim layer in this mode, so measuring it
// would never register a size change), each growing the SAME per-panel width var so dragging
// EITHER edge widens the window symmetrically — it's centered by its container's flexbox, so
// growing the width by itself already moves both edges outward evenly; the only reason two
// handles exist is so you can grab whichever edge is actually reachable/visible.
// `measure="parent"` here resolves to the panel card because these render as its DIRECT
// CHILDREN (see each panel's JSX) — the same prop the edge docks use to mean "the backdrop",
// just a different parent underneath it.
export function CenterResizeHandles({ panelKey }: { panelKey: PanelKey }) {
  const varName = `--center-w-${panelKey}`;
  return (
    <>
      <DockResizer
        varName={varName}
        measure="parent"
        scale={2}
        rangeVars={["--center-w-min", "--center-w-max"]}
        edgeClassName="dock-resizer-edge-center-left"
      />
      <DockResizer
        varName={varName}
        measure="parent"
        scale={2}
        rangeVars={["--center-w-min", "--center-w-max"]}
        edgeClassName="dock-resizer-edge-center-right"
      />
    </>
  );
}

// STACKING. Left/right/bottom docks are pinned, non-overlapping real estate MOST of the
// time — but two panels CAN share an edge (both set to "left", say), and when they do,
// something has to decide which one covers the other. `edgeZIndex` answers that from the
// user's own configured priority list (`settings.panelOrder`): index 0 sits on top of
// everything after it, deterministically, regardless of which one opened first or most
// recently. Base 40 matches the z-index the desktop dock CSS already used before any of this
// existed, so an unranked/unknown key (a future panel key nobody's added to the list yet)
// still renders above the board.
// The ranking itself moved to htl/state/panelPlacement.ts, where it sits beside the sheet rule
// that overrides it and can be tested without a DOM. Re-exported here because this is where
// every panel already imports its stacking from.
export { edgeZIndex, panelZIndex } from "@htl";

// "center" is the deliberate EXCEPTION to that fixed order (see PanelKey's own doc comment on
// `panelOrder`): it's always a full-viewport modal, so the only thing that reads as normal is
// whichever one you opened MOST RECENTLY sitting on top — like every other stack of modals
// anywhere. A single module-level counter, bumped once per open transition and shared by every
// panel that calls this hook, gives a total order across independent components without
// threading shared state through props. Returns undefined outside "center" — CSS's z-index:50
// (set on the base `.modal-backdrop` rule) already handles the single-panel case fine, and
// `edgeZIndex` above owns left/right/bottom instead.
let centerZCounter = 60; // starts above both the dock base (40) and the base modal (50)
export function useCenterZIndex(mode: PanelPlacement, open: boolean): number | undefined {
  const [z, setZ] = useState<number>();
  useEffect(() => {
    if (mode === "center" && open) setZ(++centerZCounter);
  }, [mode, open]);
  return mode === "center" ? z : undefined;
}

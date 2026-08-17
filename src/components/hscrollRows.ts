// Horizontal-scrolling control rows — the FX panels' knob rows (.sat-shared/.sat-bands), their
// mode/style rows (.sat-styles) and Delay's foot never wrap; when a deck is too narrow each row
// slides on its own. This module is what makes SLIDING a real gesture instead of a hidden
// scrollbar: click-drag across a row scrolls it, and the scroll wheel scrolls it. The tricky
// part is that these rows are FULL of ValueCells ("knobs") which own drag (vertical = value)
// and wheel (vertical = value) themselves. The contract that lets both live together:
//
//   ★ VERTICAL BELONGS TO THE KNOB, HORIZONTAL BELONGS TO THE ROW.
//   • Drag: on the first move past the slop the gesture is CLASSIFIED once — mostly-vertical
//     → the cell's value drag (unchanged); mostly-horizontal → the row scrolls, following the
//     pointer 1:1, and the cell forgets it was ever tapped (no onTap on release, no click on a
//     mode button). ValueCell does this itself for pointers it has captured (see its
//     onPointerMove); this delegate does it for everything else in the row (buttons, gaps).
//   • Wheel: over a knob, plain vertical wheel = value (unchanged); shift+wheel or a horizontal
//     wheel/trackpad swipe = slide the row. Over a button/gap, ANY wheel slides the row (a
//     horizontal strip has no other meaning for a vertical notch) — only when it overflows.
//   • Touch on buttons/gaps stays native (touch-action pan-x does it); touch on a knob is
//     touch-action:none, so the knob's own horizontal handoff scrolls the row.
//
// Installed ONCE (main.tsx) as document-level delegates; rows are recognised by class, so a new
// panel gets the behaviour by using the shared row classes and nothing else.

export const HSCROLL_ROW_SELECTOR = ".sat-shared, .sat-bands, .sat-styles, .fx-foot";
const SLOP = 4;

/** The nearest horizontally-overflowing scroll row above `el`, or null. */
export function scrollRowOf(el: Element | null): HTMLElement | null {
  const row = el?.closest?.(HSCROLL_ROW_SELECTOR) as HTMLElement | null;
  if (!row) return null;
  return row.scrollWidth > row.clientWidth + 1 ? row : null;
}

/** Slide a row by a wheel event's dominant delta (deltaMode-normalised). Returns true if it did. */
export function wheelScrollRow(row: HTMLElement, e: WheelEvent): boolean {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? row.clientWidth : 1;
  const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
  if (!d) return false;
  const before = row.scrollLeft;
  row.scrollLeft = before + d;
  return row.scrollLeft !== before;
}

let installed = false;
export function installHScrollRows() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let g: { row: HTMLElement; startX: number; startY: number; startLeft: number; scrolling: boolean; id: number } | null = null;
  let suppressClickUntil = 0;

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || e.pointerType === "touch") return; // touch: native pan-x on the row
      const t = e.target as Element | null;
      if (t?.closest?.(".vcell")) return; // the knob classifies its own gesture (ValueCell)
      const row = scrollRowOf(t);
      if (!row) return;
      g = { row, startX: e.clientX, startY: e.clientY, startLeft: row.scrollLeft, scrolling: false, id: e.pointerId };
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.scrolling) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          g = null; // a vertical gesture is not ours
          return;
        }
        g.scrolling = true;
        try {
          g.row.setPointerCapture(e.pointerId);
        } catch {
          /* fine without */
        }
      }
      g.row.scrollLeft = g.startLeft - dx;
      e.preventDefault();
    },
    true,
  );
  const end = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    if (g.scrolling) {
      suppressClickUntil = performance.now() + 250; // the click that follows a drag is not a click
      try {
        g.row.releasePointerCapture(e.pointerId);
      } catch {
        /* fine */
      }
    }
    g = null;
  };
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
  document.addEventListener(
    "click",
    (e) => {
      if (performance.now() < suppressClickUntil && (e.target as Element | null)?.closest?.(HSCROLL_ROW_SELECTOR)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener(
    "wheel",
    (e) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".vcell")) return; // the knob decides (value vs slide) itself
      const row = scrollRowOf(t);
      if (!row) return;
      if (wheelScrollRow(row, e)) e.preventDefault();
    },
    { passive: false, capture: true },
  );
}

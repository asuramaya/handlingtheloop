import { useState, type RefObject } from "react";
import {
  RESIZABLE,
  TITLE_MIN,
  NUM_W_KEY,
  NUM_MIN,
  NUM_MAX,
  WIDTHS_KEY,
  SCALE_KEY,
  SCALE_MIN,
  SCALE_MAX,
  THUMB_W_KEY,
  THUMB_MIN,
  THUMB_MAX,
  loadNumW,
  loadThumbW,
  loadWidths,
  loadScale,
  type SortKey,
} from "./trackTable";

// Column sizing for the track table: persisted widths (fractions), row scale, and the
// px widths of the # and thumbnail columns, plus the drag-to-resize handlers. Lives in a
// hook so TrackTable stays focused on rows/selection; the math is unchanged.
export function useColumnLayout(tableRef: RefObject<HTMLTableElement | null>) {
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths());
  const [scale, setScale] = useState<number>(() => loadScale());
  const [thumbW, setThumbW] = useState<number>(() => loadThumbW());
  const [numW, setNumW] = useState<number>(() => loadNumW());

  // Drag a column border to resize. A border sits on the RIGHT edge of column `id` and
  // is the divider to the next column. The intuitive rule (and the fix for the
  // "resizes the opposite side" bug): a divider between two data columns TRADES the two
  // it sits between — drag right widens the left one and narrows its right neighbour, in
  // place, Title untouched. The two EDGE dividers instead let Title (the flex column)
  // absorb the slack: Title|Artist (drag right widens Title, narrows Artist) and
  // Time|end (drag right widens Time, Title shrinks). All in fractions of table width so
  // columns stay proportional as the panel resizes.
  function startResize(e: React.PointerEvent, id: SortKey) {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort
    const order: SortKey[] = ["title", "artist", "bpm", "key", "time"];
    const rightId = order[order.indexOf(id) + 1]; // column on the divider's right (undefined at the end)
    const leftMeta = RESIZABLE.find((c) => c.id === id); // undefined for "title" (the flex absorber)
    const rightMeta = rightId ? RESIZABLE.find((c) => c.id === rightId) : undefined;
    const startX = e.clientX;
    const start = { ...widths };
    const onMove = (ev: PointerEvent) => {
      const tw = tableRef.current?.clientWidth || 1;
      const dFrac = (ev.clientX - startX) / tw;
      if (leftMeta && rightMeta) {
        // Interior divider → trade the two adjacent columns; their sum (and Title) is fixed.
        const ls = start[id] ?? leftMeta.def;
        const rs = start[rightId] ?? rightMeta.def;
        const sum = ls + rs;
        const newLeft = Math.max(leftMeta.min / tw, Math.min(sum - rightMeta.min / tw, ls + dFrac));
        setWidths((prev) => ({ ...prev, [id]: newLeft, [rightId]: sum - newLeft }));
      } else {
        // Edge divider → Title absorbs. target = the resizable side; Title is the other.
        const target = leftMeta ? id : (rightId as SortKey); // Time|end → time; Title|Artist → artist
        const meta = RESIZABLE.find((c) => c.id === target)!;
        const invert = !leftMeta; // Title is the LEFT side here → drag right widens Title, shrinks target
        const others = RESIZABLE.reduce((s, c) => (c.id === target ? s : s + (start[c.id] ?? c.def)), 0);
        const thumbPx = thumbW;
        const minFrac = meta.min / tw;
        const maxFrac = Math.max(minFrac, 1 - (TITLE_MIN + numW + thumbPx) / tw - others);
        const f = Math.max(minFrac, Math.min(maxFrac, (start[target] ?? meta.def) + dFrac * (invert ? -1 : 1)));
        setWidths((prev) => ({ ...prev, [target]: f }));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      setWidths((prev) => {
        try {
          localStorage.setItem(WIDTHS_KEY, JSON.stringify(prev));
        } catch {
          /* ignore */
        }
        return prev;
      });
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Drag the # column's header border to set its width (px) — wide enough for 3-digit
  // track numbers when you want them. Mirrors the thumbnail resize.
  function startNumResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = numW;
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      w = Math.max(NUM_MIN, Math.min(NUM_MAX, startW + (ev.clientX - startX)));
      setNumW(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      try {
        localStorage.setItem(NUM_W_KEY, String(w));
      } catch {
        /* ignore */
      }
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Drag the artwork column's header border to set how wide the thumbnail shows (px).
  function startThumbResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = thumbW;
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      w = Math.max(THUMB_MIN, Math.min(THUMB_MAX, startW + (ev.clientX - startX)));
      setThumbW(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      try {
        localStorage.setItem(THUMB_W_KEY, String(w));
      } catch {
        /* ignore */
      }
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function changeScale(delta: number) {
    setScale((s) => {
      const next = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, s + delta)) * 10) / 10;
      try {
        localStorage.setItem(SCALE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const colWidth = (id: SortKey) => {
    const f = widths[id] ?? RESIZABLE.find((c) => c.id === id)!.def;
    return `${(f * 100).toFixed(3)}%`; // fraction → CSS percentage (proportional with the table)
  };

  return { widths, scale, thumbW, numW, startResize, startNumResize, startThumbResize, changeScale, colWidth };
}

import type { TrackMeta } from "@htl/library";

// Drag payload: JSON array of videoIds (or full metas). Sidebar playlists are drop targets.
export const TRACK_DND_MIME = "application/x-htl-tracks";
// Drag payload carrying a row's index, for intra-list reorder (the Queue).
export const ROW_INDEX_MIME = "application/x-htl-row-index";

// Sortable columns (the "#" column sorts by the underlying list order).
export type SortKey = "index" | "title" | "artist" | "bpm" | "key" | "time";

export interface MenuState {
  x: number;
  y: number;
  ids: string[];
  kind: "load" | "add"; // left-click = pick a deck; right-click = file the track(s)
}

// Data columns are sized as a FRACTION of the table width (0..1) and rendered as a
// percentage, so they scale proportionally when the dock panel is resized (before,
// only Title — the flex column — grew). # and thumb stay fixed; Title is the
// auto/flex column that absorbs whatever's left, so the table always fills its
// container. `min` is a px floor; `def` is the default fraction. Each border between
// data columns drags to resize: the Title|Artist border adjusts Artist (Title
// absorbs); the others resize their own column (Title absorbs), capped so Title never
// falls under TITLE_MIN.
export const RESIZABLE: { id: SortKey; min: number; def: number }[] = [
  { id: "artist", min: 70, def: 0.22 },
  { id: "bpm", min: 44, def: 0.09 },
  { id: "key", min: 40, def: 0.08 },
  { id: "time", min: 48, def: 0.1 },
];
export const TITLE_MIN = 120; // px — Title never collapses below this; caps how wide the others grow

// The # column is a resizable PX width (its own value, like the thumb) — drag its header
// border to widen it so 3-digit track numbers (100+) stop truncating to "1…".
export const NUM_W_KEY = "htl:ttNumW";
export const NUM_MIN = 28;
export const NUM_MAX = 90;
export const NUM_DEF = 36;
export function loadNumW(): number {
  const n = Number(localStorage.getItem(NUM_W_KEY));
  return n >= NUM_MIN && n <= NUM_MAX ? n : NUM_DEF;
}

export const WIDTHS_KEY = "htl:ttCols"; // fractions (new key; the old px-based htl:ttWidths is ignored)
export const SCALE_KEY = "htl:ttScale";
export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.8;
export const SCALE_STEP = 0.1;

// The artwork column width is its own PX value (not a fraction): the row-size stepper sets
// the row HEIGHT, this sets how wide the thumbnail shows — drag its header border to resize.
export const THUMB_W_KEY = "htl:ttThumbW";
export const THUMB_MIN = 28;
export const THUMB_MAX = 160;
export const THUMB_DEF = 50;
export function loadThumbW(): number {
  const n = Number(localStorage.getItem(THUMB_W_KEY));
  return n >= THUMB_MIN && n <= THUMB_MAX ? n : THUMB_DEF;
}

// Row windowing: big libraries (1000s of tracks) lag hard if every row is in the DOM, so
// above this count we render only the visible rows (+overscan) and reserve the rest with
// spacer rows. Small lists render whole (no measuring overhead, and reorder/drag is simpler).
export const VIRT_THRESHOLD = 80;
export const ROW_OVERSCAN = 10; // rows rendered beyond the viewport on each side (smooth fast scroll)
export const ROW_H_EST = 34; // first-paint row-height guess (px), corrected by measuring a real row

export function loadWidths(): Record<string, number> {
  try {
    return { ...JSON.parse(localStorage.getItem(WIDTHS_KEY) || "{}") };
  } catch {
    return {};
  }
}
export function loadScale(): number {
  const n = Number(localStorage.getItem(SCALE_KEY));
  return n >= SCALE_MIN && n <= SCALE_MAX ? n : 1;
}

// Compare two tracks by a sort key (stable-ish; missing values sort last/low).
export function compareBy(a: TrackMeta, b: TrackMeta, key: SortKey): number {
  switch (key) {
    case "title":
      return (a.title || "").localeCompare(b.title || "");
    case "artist":
      return (a.artist || "").localeCompare(b.artist || "");
    case "bpm":
      return (a.bpm ?? -1) - (b.bpm ?? -1);
    case "key":
      return (a.key || "").localeCompare(b.key || "");
    case "time":
      return (a.duration || 0) - (b.duration || 0);
    default:
      return 0;
  }
}

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TrackMeta } from "@htl/library";
import { analysisState, cacheState } from "@htl/media";
import { fmtTime } from "../util/format";
import { CachePips, useCacheStatus } from "./CachePips";
import { useAnalysisStatus } from "./useAnalysisStatus";
import { TrackContextMenu } from "./lib/TrackContextMenu";
import { useColumnLayout } from "./lib/useColumnLayout";
import { startTouchDrag, moveTouchDrag, endTouchDrag, cancelTouchDrag, type TouchDragPayload } from "../htl/state/touchDrag";
import {
  TRACK_DND_MIME,
  ROW_INDEX_MIME,
  RESIZABLE,
  SCALE_MIN,
  SCALE_MAX,
  SCALE_STEP,
  VIRT_THRESHOLD,
  ROW_OVERSCAN,
  ROW_H_EST,
  compareBy,
  type SortKey,
  type MenuState,
} from "./lib/trackTable";

// Re-export so existing importers (LibraryPanel, Explorer, MixQueuePanel) keep `from "./TrackTable"`.
export { TRACK_DND_MIME } from "./lib/trackTable";

interface TrackTableProps {
  tracks: TrackMeta[];
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onQueue?: (track: TrackMeta) => void; // ＋ Add to the auto-mix queue
  onQueueNext?: (track: TrackMeta) => void; // ↑ Play next
  onRemove?: (videoId: string) => void;
  removeTitle?: string;
  emptyHint: string;
  loadedIds?: Set<string>;
  playlists?: { id: string; name: string }[];
  onAddToPlaylist?: (playlistId: string, track: TrackMeta) => void;
  onCreatePlaylistWith?: (tracks: TrackMeta[]) => void;
  onAddToCollection?: (track: TrackMeta) => void; // shown in the menu for non-collection views
  inCollection?: (videoId: string) => boolean;
  // --- The shared surface's contextual extras (Library / Search / Queue all use this) ---
  // Search context: the toolbar field becomes a SUBMIT search box (Enter / button fires
  // onSubmitSearch) instead of a live filter, and rows are shown as provided (the parent
  // already searched). Library/Queue leave these unset → the field filters in place.
  onSubmitSearch?: (q: string) => void;
  searching?: boolean;
  searchPlaceholder?: string;
  initialQuery?: string;
  extraCol?: { header: string; render: (t: TrackMeta, i: number) => ReactNode }; // one trailing column (Queue: transition badge)
  topSlot?: ReactNode; // above the table (Queue now-playing + seed; search states)
  footer?: ReactNode; // below the table (Queue Mix/Skip/Hold)
  onReorder?: (from: number, to: number) => void; // enables intra-list drag-reorder (Queue)
  deckLoaded?: { A: string | null; B: string | null }; // videoIds on each deck → an A/B chip on that row
  deckColors?: { A: string; B: string }; // deck accent colours for the A/B chips
  cacheFilter?: boolean; // show Cached / Stemmed toggle chips that narrow the view by pool state
}

// Imperative surface a hardware controller drives: a browse encoder moves a row cursor,
// and the deck LOAD buttons load whatever the cursor sits on. The parent (LibraryPanel)
// hands this ref to whichever table is the active view so the FLX4 wheel + LOAD A/B work.
export interface TrackTableHandle {
  moveCursor: (delta: number) => void; // step the highlight (encoder detents); opens nothing
  loadCursor: (deck: "A" | "B") => void; // load the cursor row onto a deck
  hasRows: () => boolean;
}

// rekordbox-style track list with desktop-grade interaction: click selects,
// ⌘/Ctrl-click toggles, Shift-click range-selects; right-click or long-press
// opens a context menu; rows drag onto sidebar playlists. Double-click loads to A.
// Headers sort (click to toggle asc/desc); column borders drag to resize; the −/＋
// stepper scales row size.
export const TrackTable = forwardRef<TrackTableHandle, TrackTableProps>(function TrackTable({
  tracks,
  onLoad,
  onQueue,
  onQueueNext,
  onRemove,
  removeTitle,
  emptyHint,
  loadedIds,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistWith,
  onAddToCollection,
  inCollection,
  onSubmitSearch,
  searching,
  searchPlaceholder,
  initialQuery,
  extraCol,
  topSlot,
  footer,
  onReorder,
  deckLoaded,
  deckColors,
  cacheFilter,
}: TrackTableProps, ref) {
  const searchMode = !!onSubmitSearch; // toolbar field submits a YouTube search instead of filtering
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [query, setQuery] = useState(initialQuery ?? ""); // filter (library/queue) OR search box text
  const [reorderOver, setReorderOver] = useState<number | null>(null); // queue: row being hovered for reorder
  const [cacheOnly, setCacheOnly] = useState(false); // narrow to pooled (instant-load) tracks
  const [stemOnly, setStemOnly] = useState(false); // narrow to tracks whose stems are cached
  const cacheVer = useCacheStatus(); // re-render rows (+ recompute the filter) when the manifest lands
  const tableRef = useRef<HTMLTableElement>(null);
  // Column sizing (persisted widths, row scale, # / thumb px widths + resize handlers).
  const { scale, thumbW, numW, startResize, startNumResize, startThumbResize, changeScale, colWidth } =
    useColumnLayout(tableRef);
  const anchor = useRef<number | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false); // a long-press opened the menu → swallow the trailing click
  // Touch drag-out state (see htl/state/touchDrag — native HTML5 dataTransfer drag has no touch
  // equivalent in any mobile browser). `armed` = the long-press held long enough that a SUBSEQUENT
  // move starts a drag instead of being read as a scroll; `dragging` = a touch drag is actually
  // in flight. The existing long-press-opens-the-file-menu gesture shares the same press: armed
  // + lifted-without-moving still opens the menu (unchanged feel), armed + moved starts a drag
  // instead — the same "hold, then either release or move" split iOS's own icon long-press uses.
  const touchArmed = useRef(false);
  const touchDragging = useRef(false);
  const touchStart = useRef({ x: 0, y: 0 });
  const touchPayload = useRef<TouchDragPayload | null>(null);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.videoId, t])), [tracks]);
  const canFile = !!onAddToPlaylist || !!onCreatePlaylistWith;

  // Fill blank bpm/key from the pooled `track_analysis` (the crowdsourced metadata lane) so a
  // track the user hasn't loaded this session still shows its bpm/key at a glance — and so sorting
  // by bpm/key works across the whole list. Non-mutating: enriches the DISPLAY copy only; the deck
  // load path still owns writing analysis into the persistent collection for the track playing.
  const videoIds = useMemo(() => tracks.map((t) => t.videoId), [tracks]);
  const analysisVer = useAnalysisStatus(videoIds);
  const rows = useMemo(() => {
    void analysisVer; // recompute when pooled analysis lands
    return tracks.map((t) => {
      if (t.bpm != null && t.key != null) return t;
      const a = analysisState(t.videoId);
      if (!a) return t;
      const bpm = t.bpm ?? a.bpm;
      const key = t.key ?? a.key;
      return bpm === t.bpm && key === t.key ? t : { ...t, bpm, key };
    });
  }, [tracks, analysisVer]);

  // The rows as currently ordered + filtered. In SEARCH mode the field is a submit box,
  // not a live filter, so rows pass through as provided. Otherwise the filter (title /
  // artist substring) runs first; "index" keeps source order (reversed when descending),
  // any other key sorts a copy so the original list is untouched. Reorder (queue) keeps
  // source order — sorting a reorderable list would fight the drag, so it's index-only.
  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    // No live filter in search mode (the field submits a query) nor in reorder mode (the
    // Queue is a curated order — filtering would misalign the drag indices into it).
    let filtered = searchMode || onReorder || !q
      ? rows
      : rows.filter((t) => `${t.title ?? ""} ${t.artist ?? ""}`.toLowerCase().includes(q));
    // Cache-state chips (Library / Community): narrow to pooled and/or stemmed tracks.
    // Both on ⇒ require both. Read live from the shared manifest; cacheVer forces the
    // recompute once it lands. Never applies to the reorderable queue (indices must hold).
    if (cacheFilter && !onReorder && (cacheOnly || stemOnly)) {
      filtered = filtered.filter((t) => {
        const cs = cacheState(t.videoId);
        return (!cacheOnly || cs.song) && (!stemOnly || cs.stems);
      });
    }
    if (onReorder || sortKey === "index") return sortDir === 1 || onReorder ? filtered : [...filtered].reverse();
    return [...filtered].sort((a, b) => compareBy(a, b, sortKey) * sortDir);
  }, [rows, sortKey, sortDir, query, searchMode, onReorder, cacheFilter, cacheOnly, stemOnly, cacheVer]);

  // ----- Row windowing (only render the visible slice of a large list) -----
  // Reorder lists (the queue) are small and their drag math wants every index present, so
  // they never virtualize. Everything else does past VIRT_THRESHOLD.
  const virtualize = !onReorder && view.length > VIRT_THRESHOLD;
  const [rowH, setRowH] = useState(ROW_H_EST);
  const [range, setRange] = useState({ start: 0, end: VIRT_THRESHOLD });
  const firstRowRef = useRef<HTMLTableRowElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  // The scroll container is the nearest scrollable ancestor (.lib-main in the library).
  useEffect(() => {
    let node = tableRef.current?.parentElement;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      node = node.parentElement;
    }
    scrollerRef.current = node ?? null;
  }, [view.length, virtualize]);
  // Measure a real row's height once it's painted (rows are uniform; height only changes with the
  // row-size stepper), so the spacer math + window size track the actual layout instead of the
  // estimate. Deliberately NOT keyed on scroll (range.start): re-measuring the first *rendered* row
  // on every scroll step let integer-rounded offsetHeight flip ±1px, and the top spacer (vStart *
  // rowH) multiplies that by thousands of rows → the scroll position jumps and jiggles. Functional
  // setter keeps rowH out of the deps (no stale-closure re-measure loop).
  useLayoutEffect(() => {
    const h = firstRowRef.current?.offsetHeight;
    if (h) setRowH((prev) => (Math.abs(h - prev) > 0.5 ? h : prev));
  }, [scale, view.length]);
  // Compute the visible window from the scroller's position. The table top tracks logical
  // row 0 (the spacers preserve full height), so (scrollerTop − row0Top)/rowH = rows above.
  const recompute = useCallback(() => {
    const table = tableRef.current;
    const sc = scrollerRef.current;
    if (!table || !sc) return;
    const scTop = sc.getBoundingClientRect().top;
    const theadH = table.tHead?.offsetHeight ?? 0;
    const row0 = table.getBoundingClientRect().top + theadH;
    const above = (scTop - row0) / rowH;
    const visible = sc.clientHeight / rowH;
    const start = Math.max(0, Math.floor(above) - ROW_OVERSCAN);
    const end = Math.min(view.length, Math.ceil(above + visible) + ROW_OVERSCAN);
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [rowH, view.length]);
  useEffect(() => {
    if (!virtualize) {
      setRange({ start: 0, end: view.length });
      return;
    }
    const sc = scrollerRef.current;
    if (!sc) return;
    recompute();
    sc.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      sc.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [virtualize, recompute, view.length]);
  const vStart = virtualize ? Math.min(range.start, Math.max(0, view.length)) : 0;
  const vEnd = virtualize ? Math.min(range.end, view.length) : view.length;
  const colCount = 7 + (extraCol ? 1 : 0);

  // ----- Hardware browse cursor (FLX4 wheel + LOAD A/B) -----
  // A highlighted row the browse encoder steps through and the LOAD buttons act on. The
  // ref is the source of truth so a burst of encoder detents in one frame accumulates
  // correctly (state would read stale); `cursor` only drives the highlight render.
  const cursorRef = useRef(-1);
  const [cursor, setCursor] = useState(-1);
  // Keep the cursor in range as the filter/sort/length of the view changes underneath it.
  useEffect(() => {
    if (cursorRef.current >= view.length) {
      cursorRef.current = view.length - 1;
      setCursor(cursorRef.current);
    }
  }, [view.length]);
  // Scroll a (possibly virtualized, unrendered) row into view by nudging the scroller —
  // the spacers keep full height, so logical row `idx` sits at row0 + idx*rowH regardless
  // of the rendered window. Math is in live viewport coords, so adjusting scrollTop is exact.
  const scrollCursorIntoView = useCallback(
    (idx: number) => {
      const sc = scrollerRef.current;
      const table = tableRef.current;
      if (!sc || !table) return;
      const theadH = table.tHead?.offsetHeight ?? 0;
      const scRect = sc.getBoundingClientRect();
      const row0 = table.getBoundingClientRect().top + theadH;
      const rowTop = row0 + idx * rowH;
      const rowBot = rowTop + rowH;
      const viewTop = scRect.top + theadH; // keep clear of the sticky header
      if (rowTop < viewTop) sc.scrollTop -= viewTop - rowTop + rowH;
      else if (rowBot > scRect.bottom) sc.scrollTop += rowBot - scRect.bottom + rowH;
    },
    [rowH],
  );
  useImperativeHandle(
    ref,
    () => ({
      moveCursor: (delta: number) => {
        if (view.length === 0) return;
        const cur = cursorRef.current;
        const next = cur < 0 ? (delta > 0 ? 0 : view.length - 1) : Math.max(0, Math.min(view.length - 1, cur + delta));
        cursorRef.current = next;
        setCursor(next);
        scrollCursorIntoView(next);
      },
      loadCursor: (deck: "A" | "B") => {
        const t = view[cursorRef.current];
        if (t) onLoad(deck, t);
      },
      hasRows: () => view.length > 0,
    }),
    [view, onLoad, scrollCursorIntoView],
  );

  // Close the menu on any escape hatch.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function selectOnClick(e: React.MouseEvent, i: number, id: string) {
    // Alt-click is a power gesture: load to deck B (double-click already loads A).
    if (e.altKey) {
      onLoad("B", view[i]);
      return;
    }
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = anchor.current < i ? [anchor.current, i] : [i, anchor.current];
      const range = view.slice(a, b + 1).map((t) => t.videoId);
      setSelected((prev) => {
        const s = e.ctrlKey || e.metaKey ? new Set(prev) : new Set<string>();
        range.forEach((x) => s.add(x));
        return s;
      });
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const s = new Set(prev);
        s.has(id) ? s.delete(id) : s.add(id);
        return s;
      });
      anchor.current = i;
    } else {
      setSelected(new Set([id]));
      anchor.current = i;
    }
  }

  // ids the next action applies to: the multi-selection if the target is part of
  // it, else just the target (and make it the selection).
  function targetIds(i: number, id: string): string[] {
    if (selected.has(id) && selected.size > 0) return Array.from(selected);
    setSelected(new Set([id]));
    anchor.current = i;
    return [id];
  }

  function openMenu(kind: "load" | "add", clientX: number, clientY: number, i: number, id: string) {
    setMenu({ x: clientX, y: clientY, ids: targetIds(i, id), kind });
  }

  const tracksOf = (ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is TrackMeta => !!t);

  // A clickable, sortable header cell with an asc/desc caret + (optionally) a
  // drag-to-resize border on its right edge.
  const SortTh = ({ id, label, cls, pxResize }: { id: SortKey; label: string; cls: string; pxResize?: (e: React.PointerEvent) => void }) => {
    // Title gets a handle too (its right border = the Title|Artist divider); plus every
    // resizable data column. Title isn't in RESIZABLE — it's the flex absorber — so it's
    // called out explicitly. A `pxResize` handler (the # column) drags a px width instead
    // of trading fractions.
    const hasHandle = !!pxResize || id === "title" || RESIZABLE.some((c) => c.id === id);
    return (
      <th
        className={`${cls} tt-sortable ${sortKey === id ? "sorted" : ""}`}
        onClick={() => toggleSort(id)}
        title={`Sort by ${label || "track #"}`}
      >
        <span className="tt-th-label">
          {label}
          {sortKey === id && <span className="tt-caret">{sortDir === 1 ? "▲" : "▼"}</span>}
        </span>
        {hasHandle && (
          <span className="col-resize" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => (pxResize ? pxResize(e) : startResize(e, id))} />
        )}
      </th>
    );
  };

  return (
    <>
      <div className="tt-toolbar">
        {!onReorder && (
          <div className="tt-filter">
            <span className="tt-filter-ico" aria-hidden="true">{searchMode ? "🔍" : "🔎"}</span>
            <input
              className="tt-filter-input"
              type="search"
              value={query}
              placeholder={searchPlaceholder ?? (searchMode ? "Search YouTube, or paste a link…" : "Filter…")}
              aria-label={searchMode ? "Search" : "Filter tracks"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (searchMode) onSubmitSearch!(query.trim());
                  e.currentTarget.blur(); // hand the keyboard back to the decks after committing
                }
              }}
            />
            {query && !searchMode && (
              <button className="tt-filter-clear" onClick={() => setQuery("")} aria-label="Clear filter">
                ✕
              </button>
            )}
          </div>
        )}
        {onReorder && <span className="tt-queue-label">Up next</span>}
        {cacheFilter && !onReorder && (
          <div className="tt-cache-chips" role="group" aria-label="Filter by cache state">
            <button
              className={`tt-chip ${cacheOnly ? "on" : ""}`}
              aria-pressed={cacheOnly}
              onClick={() => setCacheOnly((v) => !v)}
            >
              <span className="pip pip-song" /> Cached
            </button>
            <button
              className={`tt-chip ${stemOnly ? "on" : ""}`}
              aria-pressed={stemOnly}
              onClick={() => setStemOnly((v) => !v)}
            >
              <span className="pip pip-stems" /> Stemmed
            </button>
          </div>
        )}
        {searchMode && (
          <button className="tt-search-btn btn" onClick={() => onSubmitSearch!(query.trim())} disabled={searching || !query.trim()}>
            {searching ? "…" : "Search"}
          </button>
        )}
        {/* Rows-size stepper as ONE right-pinned unit — keeping − and ＋ together (they were
            loose toolbar children, so space-between flung them to opposite ends). */}
        <div className="tt-rows">
          <span className="tt-rows-label">Rows</span>
          <button className="tt-step" onClick={() => changeScale(-SCALE_STEP)} disabled={scale <= SCALE_MIN}>
            −
          </button>
          <button className="tt-step" onClick={() => changeScale(SCALE_STEP)} disabled={scale >= SCALE_MAX}>
            ＋
          </button>
        </div>
      </div>

      {topSlot}

      {tracks.length === 0 ? (
        <div className="lib-empty">{emptyHint}</div>
      ) : (
        <table
          ref={tableRef}
          className="track-table"
          style={{ fontSize: `${13 * scale}px`, ["--tt-row-pad" as string]: `${Math.round(7 * scale)}px` }}
        >
          {/* Column widths live here (one place) so table-layout:fixed resizing is
              stable — the resizable columns carry the dragged width, Title (auto)
              absorbs the rest. Dropping narrow columns is a container query on the
              .col-* classes (which sit on the cells), independent of these. */}
          <colgroup>
            <col className="col-num" style={{ width: `${numW}px` }} />
            <col className="col-thumb" style={{ width: `${thumbW}px` }} />
            <col className="col-title" />
            <col className="col-artist" style={{ width: colWidth("artist") }} />
            <col className="col-bpm" style={{ width: colWidth("bpm") }} />
            <col className="col-key" style={{ width: colWidth("key") }} />
            <col className="col-time" style={{ width: colWidth("time") }} />
            {extraCol && <col className="col-extra" />}
          </colgroup>
          <thead>
            <tr>
              <SortTh id="index" label="#" cls="col-num" pxResize={startNumResize} />
              <th className="col-thumb">
                <span className="col-resize" onClick={(e) => e.stopPropagation()} onPointerDown={startThumbResize} />
              </th>
              <SortTh id="title" label="Title" cls="col-title" />
              <SortTh id="artist" label="Artist" cls="col-artist" />
              <SortTh id="bpm" label="BPM" cls="col-bpm" />
              <SortTh id="key" label="Key" cls="col-key" />
              <SortTh id="time" label="Time" cls="col-time" />
              {extraCol && <th className="col-extra">{extraCol.header}</th>}
            </tr>
          </thead>
          <tbody>
            {/* Top spacer reserves the height of the rows scrolled above the window. */}
            {vStart > 0 && (
              <tr aria-hidden="true" className="tt-spacer">
                <td colSpan={colCount} style={{ height: vStart * rowH, padding: 0, border: 0 }} />
              </tr>
            )}
            {view.slice(vStart, vEnd).map((t, k) => {
              const i = vStart + k; // true index into `view` (selection/menus/reorder use it)
              return (
              <tr
                ref={k === 0 ? firstRowRef : undefined}
                key={`${t.videoId}:${i}`}
                className={`${loadedIds?.has(t.videoId) ? "loaded" : ""} ${selected.has(t.videoId) ? "selected" : ""} ${reorderOver === i ? "reorder-over" : ""} ${i === cursor ? "tt-cursor" : ""}`}
                draggable
                onClick={(e) => {
                  // Left click → the "Load to Deck A / B" menu (pick a deck). Modifier-
                  // clicks keep the power gestures: ⌘/Ctrl/Shift multi-select, Alt loads
                  // deck B straight away. A long-press that already opened a menu
                  // suppresses the trailing click.
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
                    selectOnClick(e, i, t.videoId);
                    return;
                  }
                  openMenu("load", e.clientX, e.clientY, i, t.videoId);
                }}
                onContextMenu={(e) => {
                  // Right click → the file menu (add to playlist / collection, remove).
                  e.preventDefault();
                  openMenu("add", e.clientX, e.clientY, i, t.videoId);
                }}
                onTouchStart={(e) => {
                  const touch = e.touches[0];
                  if (!touch) return;
                  touchStart.current = { x: touch.clientX, y: touch.clientY };
                  touchArmed.current = false;
                  touchDragging.current = false;
                  // Hold 480ms and the press is ARMED — same threshold the file menu always
                  // used, just decided a beat later than before: a lift right after arming (no
                  // move) still opens the file menu exactly as it always did; a MOVE after
                  // arming redirects into a touch drag instead. See htl/state/touchDrag.
                  longPress.current = window.setTimeout(() => {
                    touchArmed.current = true;
                    navigator.vibrate?.(8);
                  }, 480);
                }}
                onTouchEnd={(e) => {
                  clearTimeout(longPress.current);
                  if (touchDragging.current) {
                    touchDragging.current = false;
                    const touch = e.changedTouches[0];
                    if (touchPayload.current) endTouchDrag(touchPayload.current, touch?.clientX ?? touchStart.current.x, touch?.clientY ?? touchStart.current.y);
                    return;
                  }
                  if (touchArmed.current) {
                    // Armed but never moved — the original long-press behaviour: open the file menu.
                    touchArmed.current = false;
                    suppressClick.current = true;
                    const touch = e.changedTouches[0];
                    openMenu("add", touch?.clientX ?? touchStart.current.x, touch?.clientY ?? touchStart.current.y, i, t.videoId);
                  }
                }}
                onTouchCancel={() => {
                  clearTimeout(longPress.current);
                  if (touchDragging.current) cancelTouchDrag();
                  touchArmed.current = false;
                  touchDragging.current = false;
                }}
                onTouchMove={(e) => {
                  const touch = e.touches[0];
                  if (!touch) return;
                  if (!touchArmed.current) {
                    clearTimeout(longPress.current); // pre-arm movement = a scroll, not a hold
                    return;
                  }
                  if (!touchDragging.current) {
                    touchDragging.current = true;
                    const metas = tracksOf(targetIds(i, t.videoId));
                    touchPayload.current = { tracks: metas, label: metas.length > 1 ? `${metas.length} tracks` : t.title, thumbnail: t.thumbnail };
                    startTouchDrag(touchPayload.current, touch.clientX, touch.clientY);
                  } else if (touchPayload.current) {
                    moveTouchDrag(touchPayload.current, touch.clientX, touch.clientY);
                  }
                  e.preventDefault(); // committed to a drag — stop the list from also scrolling
                }}
                onDragStart={(e) => {
                  // Carry the FULL track metas (not just ids) so a dragged Community /
                  // search track — which isn't in the collection map yet — can still be
                  // filed onto a playlist or the collection at the drop site. A reorderable
                  // list (Queue) ALSO carries the row index for the intra-list move.
                  const metas = tracksOf(targetIds(i, t.videoId));
                  e.dataTransfer.setData(TRACK_DND_MIME, JSON.stringify(metas));
                  if (onReorder) {
                    e.dataTransfer.setData(ROW_INDEX_MIME, String(i));
                    e.dataTransfer.effectAllowed = "copyMove";
                  } else {
                    e.dataTransfer.effectAllowed = "copy";
                  }
                }}
                onDragOver={(e) => {
                  if (!onReorder || !e.dataTransfer.types.includes(ROW_INDEX_MIME)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (reorderOver !== i) setReorderOver(i);
                }}
                onDragLeave={() => setReorderOver((d) => (d === i ? null : d))}
                onDrop={(e) => {
                  if (!onReorder) return;
                  setReorderOver(null);
                  const raw = e.dataTransfer.getData(ROW_INDEX_MIME);
                  if (!raw) return;
                  e.preventDefault();
                  const from = Number(raw);
                  if (Number.isInteger(from) && from !== i) onReorder(from, i);
                }}
              >
                <td className="col-num">{i + 1}</td>
                <td className="col-thumb">{t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}</td>
                <td className="col-title" title={t.title}>
                  {(() => {
                    const d = deckLoaded?.A === t.videoId ? "A" : deckLoaded?.B === t.videoId ? "B" : null;
                    return d ? (
                      <span className="tt-deck" style={{ background: deckColors?.[d] }} title={`Loaded on Deck ${d}`}>
                        {d}
                      </span>
                    ) : null;
                  })()}
                  <CachePips videoId={t.videoId} />
                  {t.title}
                </td>
                <td className="col-artist" title={t.artist}>
                  {t.artist}
                </td>
                <td className="col-bpm">{t.bpm != null ? t.bpm.toFixed(1) : "—"}</td>
                <td className="col-key">{t.key || "—"}</td>
                <td className="col-time">{fmtTime(t.duration)}</td>
                {extraCol && <td className="col-extra">{extraCol.render(t, i)}</td>}
              </tr>
              );
            })}
            {/* Bottom spacer reserves the height of the rows below the window. */}
            {vEnd < view.length && (
              <tr aria-hidden="true" className="tt-spacer">
                <td colSpan={colCount} style={{ height: (view.length - vEnd) * rowH, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      )}
      {footer}
      {tracks.length > 0 && view.length === 0 && !searchMode && (
        <div className="lib-empty">
          {query.trim()
            ? `No tracks match “${query.trim()}”.`
            : stemOnly && cacheOnly
              ? "No cached tracks with stems here yet."
              : stemOnly
                ? "No tracks with cached stems here yet."
                : "No cached tracks here yet."}
        </div>
      )}

      {menu && (
        <TrackContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          byId={byId}
          onLoad={onLoad}
          onQueue={onQueue}
          onQueueNext={onQueueNext}
          onRemove={onRemove}
          removeTitle={removeTitle}
          playlists={playlists}
          onAddToPlaylist={onAddToPlaylist}
          onCreatePlaylistWith={onCreatePlaylistWith}
          onAddToCollection={onAddToCollection}
          inCollection={inCollection}
          canFile={canFile}
          onClearSelection={() => setSelected(new Set())}
        />
      )}
    </>
  );
});

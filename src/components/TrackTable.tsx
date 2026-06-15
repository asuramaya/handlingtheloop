import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TrackMeta } from "@htl/library";
import { fmtTime } from "../util/format";
import { CachePips, useCacheStatus } from "./CachePips";

// Drag payload: JSON array of videoIds. Sidebar playlists are drop targets.
export const TRACK_DND_MIME = "application/x-htl-tracks";
// Drag payload carrying a row's index, for intra-list reorder (the Queue).
const ROW_INDEX_MIME = "application/x-htl-row-index";

interface TrackTableProps {
  tracks: TrackMeta[];
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
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
}

interface MenuState {
  x: number;
  y: number;
  ids: string[];
  kind: "load" | "add"; // left-click = pick a deck; right-click = file the track(s)
}

// Sortable columns (the "#" column sorts by the underlying list order).
type SortKey = "index" | "title" | "artist" | "bpm" | "key" | "time";

// Data columns are sized as a FRACTION of the table width (0..1) and rendered as a
// percentage, so they scale proportionally when the dock panel is resized (before,
// only Title — the flex column — grew). # and thumb stay fixed; Title is the
// auto/flex column that absorbs whatever's left, so the table always fills its
// container. `min` is a px floor; `def` is the default fraction. Each border between
// data columns drags to resize: the Title|Artist border adjusts Artist (Title
// absorbs); the others resize their own column (Title absorbs), capped so Title never
// falls under TITLE_MIN.
const RESIZABLE: { id: SortKey; min: number; def: number }[] = [
  { id: "artist", min: 70, def: 0.22 },
  { id: "bpm", min: 44, def: 0.09 },
  { id: "key", min: 40, def: 0.08 },
  { id: "time", min: 48, def: 0.1 },
];
const TITLE_MIN = 120; // px — Title never collapses below this; caps how wide the others grow
const FIXED_PX = 36; // the # column (px); the thumb column is added live (it scales with row size)
const WIDTHS_KEY = "htl:ttCols"; // fractions (new key; the old px-based htl:ttWidths is ignored)
const SCALE_KEY = "htl:ttScale";
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.8;
const SCALE_STEP = 0.1;
// The artwork column width is its own PX value (not a fraction): the row-size stepper sets
// the row HEIGHT, this sets how wide the thumbnail shows — drag its header border to resize.
const THUMB_W_KEY = "htl:ttThumbW";
const THUMB_MIN = 28;
const THUMB_MAX = 160;
const THUMB_DEF = 50;
function loadThumbW(): number {
  const n = Number(localStorage.getItem(THUMB_W_KEY));
  return n >= THUMB_MIN && n <= THUMB_MAX ? n : THUMB_DEF;
}

function loadWidths(): Record<string, number> {
  try {
    return { ...JSON.parse(localStorage.getItem(WIDTHS_KEY) || "{}") };
  } catch {
    return {};
  }
}
function loadScale(): number {
  const n = Number(localStorage.getItem(SCALE_KEY));
  return n >= SCALE_MIN && n <= SCALE_MAX ? n : 1;
}

// Compare two tracks by a sort key (stable-ish; missing values sort last/low).
function compareBy(a: TrackMeta, b: TrackMeta, key: SortKey): number {
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

// rekordbox-style track list with desktop-grade interaction: click selects,
// ⌘/Ctrl-click toggles, Shift-click range-selects; right-click or long-press
// opens a context menu; rows drag onto sidebar playlists. Double-click loads to A.
// Headers sort (click to toggle asc/desc); column borders drag to resize; the −/＋
// stepper scales row size.
export function TrackTable({
  tracks,
  onLoad,
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
}: TrackTableProps) {
  const searchMode = !!onSubmitSearch; // toolbar field submits a YouTube search instead of filtering
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [query, setQuery] = useState(initialQuery ?? ""); // filter (library/queue) OR search box text
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths());
  const [scale, setScale] = useState<number>(() => loadScale());
  const [thumbW, setThumbW] = useState<number>(() => loadThumbW());
  const [reorderOver, setReorderOver] = useState<number | null>(null); // queue: row being hovered for reorder
  useCacheStatus(); // re-render rows when the cached-pool manifest lands
  const tableRef = useRef<HTMLTableElement>(null);
  const anchor = useRef<number | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false); // a long-press opened the menu → swallow the trailing click
  const byId = useMemo(() => new Map(tracks.map((t) => [t.videoId, t])), [tracks]);
  const canFile = !!onAddToPlaylist || !!onCreatePlaylistWith;

  // The rows as currently ordered + filtered. In SEARCH mode the field is a submit box,
  // not a live filter, so rows pass through as provided. Otherwise the filter (title /
  // artist substring) runs first; "index" keeps source order (reversed when descending),
  // any other key sorts a copy so the original list is untouched. Reorder (queue) keeps
  // source order — sorting a reorderable list would fight the drag, so it's index-only.
  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    // No live filter in search mode (the field submits a query) nor in reorder mode (the
    // Queue is a curated order — filtering would misalign the drag indices into it).
    const filtered = searchMode || onReorder || !q
      ? tracks
      : tracks.filter((t) => `${t.title ?? ""} ${t.artist ?? ""}`.toLowerCase().includes(q));
    if (onReorder || sortKey === "index") return sortDir === 1 || onReorder ? filtered : [...filtered].reverse();
    return [...filtered].sort((a, b) => compareBy(a, b, sortKey) * sortDir);
  }, [tracks, sortKey, sortDir, query, searchMode, onReorder]);

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
        const maxFrac = Math.max(minFrac, 1 - (TITLE_MIN + FIXED_PX + thumbPx) / tw - others);
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
  const SortTh = ({ id, label, cls }: { id: SortKey; label: string; cls: string }) => {
    // Title gets a handle too (its right border = the Title|Artist divider); plus every
    // resizable data column. Title isn't in RESIZABLE — it's the flex absorber — so it's
    // called out explicitly.
    const hasHandle = id === "title" || RESIZABLE.some((c) => c.id === id);
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
        {hasHandle && <span className="col-resize" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => startResize(e, id)} />}
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
                if (searchMode && e.key === "Enter") onSubmitSearch!(query.trim());
              }}
            />
            {query && !searchMode && (
              <button className="tt-filter-clear" title="Clear filter" onClick={() => setQuery("")} aria-label="Clear filter">
                ✕
              </button>
            )}
          </div>
        )}
        {onReorder && <span className="tt-queue-label">Up next</span>}
        {searchMode && (
          <button className="tt-search-btn btn" onClick={() => onSubmitSearch!(query.trim())} disabled={searching || !query.trim()}>
            {searching ? "…" : "Search"}
          </button>
        )}
        <span className="tt-rows-label">Rows</span>
        <button className="tt-step" title="Smaller rows" onClick={() => changeScale(-SCALE_STEP)} disabled={scale <= SCALE_MIN}>
          −
        </button>
        <button className="tt-step" title="Larger rows" onClick={() => changeScale(SCALE_STEP)} disabled={scale >= SCALE_MAX}>
          ＋
        </button>
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
            <col className="col-num" />
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
              <SortTh id="index" label="#" cls="col-num" />
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
            {view.map((t, i) => (
              <tr
                key={`${t.videoId}:${i}`}
                className={`${loadedIds?.has(t.videoId) ? "loaded" : ""} ${selected.has(t.videoId) ? "selected" : ""} ${reorderOver === i ? "reorder-over" : ""}`}
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
                  // Long-press = the file menu (the touch stand-in for right-click).
                  longPress.current = window.setTimeout(() => {
                    suppressClick.current = true;
                    openMenu("add", touch.clientX, touch.clientY, i, t.videoId);
                  }, 480);
                }}
                onTouchEnd={() => clearTimeout(longPress.current)}
                onTouchMove={() => clearTimeout(longPress.current)}
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
            ))}
          </tbody>
        </table>
      )}
      {footer}
      {tracks.length > 0 && view.length === 0 && query && !searchMode && (
        <div className="lib-empty">No tracks match “{query.trim()}”.</div>
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
          <div
            className="ctx-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 320) }}
          >
            {menu.ids.length > 1 && <div className="ctx-count">{menu.ids.length} tracks</div>}

            {/* LEFT-click menu: just pick a deck. */}
            {menu.kind === "load" && (
              <>
                <button
                  onClick={() => {
                    const t = byId.get(menu.ids[0]);
                    if (t) onLoad("A", t);
                    setMenu(null);
                  }}
                >
                  ▶ Load to Deck A
                </button>
                <button
                  onClick={() => {
                    const t = byId.get(menu.ids[0]);
                    if (t) onLoad("B", t);
                    setMenu(null);
                  }}
                >
                  ▶ Load to Deck B
                </button>
              </>
            )}

            {/* RIGHT-click menu: file the track(s). */}
            {menu.kind === "add" && (
              <>
                {onAddToCollection &&
                  (() => {
                    const targets = tracksOf(menu.ids).filter((t) => !inCollection?.(t.videoId));
                    if (!targets.length) return <div className="ctx-label">✓ In collection</div>;
                    return (
                      <button
                        onClick={() => {
                          targets.forEach((t) => onAddToCollection(t));
                          setMenu(null);
                        }}
                      >
                        ＋ Add to collection
                      </button>
                    );
                  })()}
                {canFile && (
                  <>
                    <div className="ctx-label">Add to playlist</div>
                    {(playlists ?? []).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          tracksOf(menu.ids).forEach((t) => onAddToPlaylist?.(p.id, t));
                          setMenu(null);
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                    {onCreatePlaylistWith && (
                      <button
                        className="ctx-new"
                        onClick={() => {
                          onCreatePlaylistWith(tracksOf(menu.ids));
                          setMenu(null);
                        }}
                      >
                        ＋ New playlist…
                      </button>
                    )}
                  </>
                )}
                {onRemove && (
                  <>
                    <div className="ctx-sep" />
                    <button
                      className="ctx-danger"
                      onClick={() => {
                        menu.ids.forEach((id) => onRemove(id));
                        setSelected(new Set());
                        setMenu(null);
                      }}
                    >
                      ✕ {removeTitle ?? "Remove"}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

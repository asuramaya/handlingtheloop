import { useEffect, useMemo, useRef, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { fmtTime } from "../util/format";
import { CachePips, useCacheStatus } from "./CachePips";

// Drag payload: JSON array of videoIds. Sidebar playlists are drop targets.
export const TRACK_DND_MIME = "application/x-htl-tracks";

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
}: TrackTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [query, setQuery] = useState(""); // in-library filter (title / artist)
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths());
  const [scale, setScale] = useState<number>(() => loadScale());
  useCacheStatus(); // re-render rows when the cached-pool manifest lands
  const tableRef = useRef<HTMLTableElement>(null);
  const anchor = useRef<number | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false); // a long-press opened the menu → swallow the trailing click
  const byId = useMemo(() => new Map(tracks.map((t) => [t.videoId, t])), [tracks]);
  const canFile = !!onAddToPlaylist || !!onCreatePlaylistWith;

  // The rows as currently ordered + filtered. The filter (title / artist substring)
  // runs first; "index" then keeps source order (reversed when descending), any other
  // key sorts a copy so the original list is untouched.
  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? tracks.filter((t) => `${t.title ?? ""} ${t.artist ?? ""}`.toLowerCase().includes(q))
      : tracks;
    if (sortKey === "index") return sortDir === 1 ? filtered : [...filtered].reverse();
    return [...filtered].sort((a, b) => compareBy(a, b, sortKey) * sortDir);
  }, [tracks, sortKey, sortDir, query]);

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

  // Drag a column border to resize. Everything works in fractions of the table width
  // (so columns stay proportional as the panel resizes) and Title (the auto/flex
  // column) absorbs the difference, so the table always fills its container. The Title
  // handle resizes the Title|Artist border — it shrinks/grows Artist inversely (drag
  // right widens Title, narrows Artist); every other border resizes its own column. A
  // column can't drop below its px min, nor grow so far that Title falls under
  // TITLE_MIN — that cap is what lets you widen Title by narrowing any other column.
  function startResize(e: React.PointerEvent, id: SortKey) {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort
    const target = id === "title" ? "artist" : id; // the Title handle drives Artist…
    const invert = id === "title"; // …inverted, so dragging right widens Title
    const meta = RESIZABLE.find((c) => c.id === target);
    if (!meta) return;
    const startX = e.clientX;
    const startFrac = widths[target] ?? meta.def;
    const onMove = (ev: PointerEvent) => {
      const tw = tableRef.current?.clientWidth || 1;
      // The other columns + the fixed #/thumb columns + Title's floor bound how wide
      // this one may grow before Title would be squeezed past TITLE_MIN.
      const othersFrac = RESIZABLE.reduce((s, c) => (c.id === target ? s : s + (widths[c.id] ?? c.def)), 0);
      const thumbPx = 3.8 * 13 * scale; // .col-thumb is 3.8em of the scaled font-size
      const minFrac = meta.min / tw;
      const maxFrac = Math.max(minFrac, 1 - (TITLE_MIN + FIXED_PX + thumbPx) / tw - othersFrac);
      const dFrac = ((ev.clientX - startX) / tw) * (invert ? -1 : 1);
      const f = Math.max(minFrac, Math.min(maxFrac, startFrac + dFrac));
      setWidths((prev) => ({ ...prev, [target]: f }));
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

  if (tracks.length === 0) return <div className="lib-empty">{emptyHint}</div>;

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
        <div className="tt-filter">
          <span className="tt-filter-ico" aria-hidden="true">🔎</span>
          <input
            className="tt-filter-input"
            type="search"
            value={query}
            placeholder="Filter…"
            aria-label="Filter tracks"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="tt-filter-clear" title="Clear filter" onClick={() => setQuery("")} aria-label="Clear filter">
              ✕
            </button>
          )}
        </div>
        <span className="tt-rows-label">Rows</span>
        <button className="tt-step" title="Smaller rows" onClick={() => changeScale(-SCALE_STEP)} disabled={scale <= SCALE_MIN}>
          −
        </button>
        <button className="tt-step" title="Larger rows" onClick={() => changeScale(SCALE_STEP)} disabled={scale >= SCALE_MAX}>
          ＋
        </button>
      </div>
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
          <col className="col-thumb" />
          <col className="col-title" />
          <col className="col-artist" style={{ width: colWidth("artist") }} />
          <col className="col-bpm" style={{ width: colWidth("bpm") }} />
          <col className="col-key" style={{ width: colWidth("key") }} />
          <col className="col-time" style={{ width: colWidth("time") }} />
        </colgroup>
        <thead>
          <tr>
            <SortTh id="index" label="#" cls="col-num" />
            <th className="col-thumb"></th>
            <SortTh id="title" label="Title" cls="col-title" />
            <SortTh id="artist" label="Artist" cls="col-artist" />
            <SortTh id="bpm" label="BPM" cls="col-bpm" />
            <SortTh id="key" label="Key" cls="col-key" />
            <SortTh id="time" label="Time" cls="col-time" />
          </tr>
        </thead>
        <tbody>
          {view.map((t, i) => (
            <tr
              key={t.videoId}
              className={`${loadedIds?.has(t.videoId) ? "loaded" : ""} ${selected.has(t.videoId) ? "selected" : ""}`}
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
                // filed onto a playlist or the collection at the drop site.
                const metas = tracksOf(targetIds(i, t.videoId));
                e.dataTransfer.setData(TRACK_DND_MIME, JSON.stringify(metas));
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <td className="col-num">{i + 1}</td>
              <td className="col-thumb">{t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}</td>
              <td className="col-title" title={t.title}>
                <CachePips videoId={t.videoId} />
                {t.title}
              </td>
              <td className="col-artist" title={t.artist}>
                {t.artist}
              </td>
              <td className="col-bpm">{t.bpm != null ? t.bpm.toFixed(1) : "—"}</td>
              <td className="col-key">{t.key || "—"}</td>
              <td className="col-time">{fmtTime(t.duration)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.length === 0 && query && (
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

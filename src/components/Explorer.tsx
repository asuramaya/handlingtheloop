import { useEffect, useMemo, useRef, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { searchYouTube, fetchMeta, parseVideoId, parsePlaylistId } from "@htl/media";
import { loadSearchState, saveSearchState, type SortKey } from "@htl/state";
import { fmtTime, fmtViews } from "../util/format";

interface ExplorerProps {
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onAdd: (track: TrackMeta) => void;
  inCollection: (videoId: string) => boolean;
  // Paste a playlist link/id → pull it straight into the library.
  onIngestPlaylist: (listId: string) => Promise<void>;
  playlists: { id: string; name: string }[];
  onAddToPlaylist: (playlistId: string, track: TrackMeta) => void;
  onCreatePlaylistWith: (tracks: TrackMeta[]) => void;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "relevance", label: "Relevance" },
  { key: "title", label: "Title A–Z" },
  { key: "artist", label: "Artist A–Z" },
  { key: "duration", label: "Duration" },
  { key: "views", label: "Most viewed" },
];

function sortResults(list: TrackMeta[], sort: SortKey): TrackMeta[] {
  if (sort === "relevance") return list;
  const by = [...list];
  by.sort((a, b) => {
    switch (sort) {
      case "title":
        return a.title.localeCompare(b.title);
      case "artist":
        return (a.artist || "").localeCompare(b.artist || "") || a.title.localeCompare(b.title);
      case "duration":
        return a.duration - b.duration;
      case "views":
        return (b.views ?? -1) - (a.views ?? -1);
      default:
        return 0;
    }
  });
  return by;
}

// Live YouTube search that also ingests pasted links: a video URL/id resolves to
// a single result, a playlist URL/id is pulled straight into the library. Only
// YouTube — there's no arbitrary-URL import, so nothing untrusted gets fetched.
// Query/results/filter/sort persist (see searchState) so a dig survives reopen.
export function Explorer({ onLoad, onAdd, inCollection, onIngestPlaylist, playlists, onAddToPlaylist, onCreatePlaylistWith }: ExplorerProps) {
  const saved = useRef(loadSearchState()).current;
  const [query, setQuery] = useState(saved.query);
  const [results, setResults] = useState<TrackMeta[]>(saved.results);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(saved.searched);
  const [filter, setFilter] = useState(saved.filter);
  const [sort, setSort] = useState<SortKey>(saved.sort);
  const [menu, setMenu] = useState<{ x: number; y: number; t: TrackMeta; kind: "load" | "add" } | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false); // a long-press opened the file menu → swallow the click
  const abort = useRef<AbortController | null>(null);

  // Close the actions menu on escape / scroll / resize.
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

  // Persist the dig-session (not the transient request/error state).
  useEffect(() => {
    saveSearchState({ query, results, searched, filter, sort });
  }, [query, results, searched, filter, sort]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? results.filter((t) => t.title.toLowerCase().includes(f) || (t.artist || "").toLowerCase().includes(f))
      : results;
    return sortResults(filtered, sort);
  }, [results, filter, sort]);

  async function run() {
    const q = query.trim();
    if (!q) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSearching(true);
    setError(null);
    setSearched(true);
    // A pasted video link resolves to a single result; a playlist link is pulled
    // into the library; anything else is a normal text search. (Video wins over a
    // trailing &list= so "watch?v=…&list=…" loads the video you clicked.)
    const vid = parseVideoId(q);
    const list = vid ? null : parsePlaylistId(q);
    try {
      if (vid) {
        const meta = await fetchMeta(vid, ctrl.signal);
        if (!ctrl.signal.aborted) {
          setResults([meta]);
          setQuery("");
        }
      } else if (list) {
        await onIngestPlaylist(list); // closes the modal on success
      } else {
        const r = await searchYouTube(q, 30, ctrl.signal);
        if (!ctrl.signal.aborted) setResults(r);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setSearching(false);
    }
  }

  return (
    <div className="explorer">
      <div className="search-bar">
        <input
          className="search-input"
          placeholder="Search YouTube, or paste a video / playlist link…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          autoFocus
        />
        <button className="btn" onClick={run} disabled={searching || !query.trim()}>
          {searching ? "…" : "Search"}
        </button>
      </div>

      {results.length > 0 && (
        <div className="result-tools">
          <input
            className="result-filter"
            placeholder="Filter results…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="result-sort">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <span className="result-count">
            {shown.length}
            {shown.length !== results.length ? `/${results.length}` : ""}
          </span>
        </div>
      )}

      {error && <div className="lib-empty error">{error}</div>}
      {!error && searched && !searching && results.length === 0 && (
        <div className="lib-empty">No results.</div>
      )}
      {!error && results.length > 0 && shown.length === 0 && (
        <div className="lib-empty">Nothing matches “{filter}”.</div>
      )}
      {!searched && !error && results.length === 0 && (
        <div className="lib-empty">
          Search YouTube to find tracks, then load or save them — or paste a video or playlist link to pull it in.
        </div>
      )}

      <div className="result-list">
        {shown.map((t) => (
          <div
            className="result-row"
            key={t.videoId}
            // Left click / tap → pick a deck; right click / long-press → file menu.
            onClick={(e) => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              setMenu({ x: e.clientX, y: e.clientY, t, kind: "load" });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, t, kind: "add" });
            }}
            onTouchStart={(e) => {
              const touch = e.touches[0];
              longPress.current = window.setTimeout(() => {
                suppressClick.current = true;
                setMenu({ x: touch.clientX, y: touch.clientY, t, kind: "add" });
              }, 480);
            }}
            onTouchEnd={() => clearTimeout(longPress.current)}
            onTouchMove={() => clearTimeout(longPress.current)}
          >
            <div className="thumb">
              {t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}
              <span className="thumb-time">{fmtTime(t.duration)}</span>
            </div>
            <div className="result-meta">
              <div className="result-title" title={t.title}>
                {t.title}
              </div>
              <div className="result-sub">
                {t.artist}
                {t.views != null && <span className="dot">·</span>}
                {t.views != null && `${fmtViews(t.views)} views`}
              </div>
            </div>
          </div>
        ))}
      </div>

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
          <div
            className="ctx-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 200) }}
          >
            {menu.kind === "load" ? (
              <>
                <button onClick={() => { onLoad("A", menu.t); setMenu(null); }}>▶ Load to Deck A</button>
                <button onClick={() => { onLoad("B", menu.t); setMenu(null); }}>▶ Load to Deck B</button>
              </>
            ) : (
              <>
                <button
                  disabled={inCollection(menu.t.videoId)}
                  onClick={() => { onAdd(menu.t); setMenu(null); }}
                >
                  {inCollection(menu.t.videoId) ? "✓ In collection" : "＋ Add to collection"}
                </button>
                <div className="ctx-label">Add to playlist</div>
                {playlists.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { onAddToPlaylist(p.id, menu.t); setMenu(null); }}
                  >
                    {p.name}
                  </button>
                ))}
                <button className="ctx-new" onClick={() => { onCreatePlaylistWith([menu.t]); setMenu(null); }}>
                  ＋ New playlist…
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
